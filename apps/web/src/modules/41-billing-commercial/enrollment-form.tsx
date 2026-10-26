// apps/web/src/modules/41-billing-commercial — ADD / EDIT AN ENROLLMENT (M41). The form in the enrollments drawer.
//   POST  /api/v1/billing/commercial/enrollments        add     (manage_enrollment, fresh step-up, Idempotency-Key per attempt)
//   PATCH /api/v1/billing/commercial/enrollments/{id}   edit    (status, end date and evidence only; payer, clearinghouse and start are fixed)
// Both writes need a FRESH step-up. A refusal saves what was typed (never a secret: an enrollment holds none) under the shared
// step-up draft key and sends the user to /step-up; on return the form is restored and the user submits again, nothing is sent
// on their behalf. Client checks only mirror the server (key and evidence patterns, end not before start); the server stays the
// authority and its 404 / 409 / 422 are shown inline in fixed words, never echoed.
import { Button, InlineAlert, SelectField, TextField, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import {
  ENROLLMENT_EVIDENCE_PATTERN,
  ENROLLMENT_KEY_PATTERN,
  ENROLLMENT_STATUS_VALUES,
  type EnrollmentView,
  enrollmentLabel,
  isEnrollmentStatus,
} from "./commercial-model";

export const ENROLLMENT_CREATE_ACTION = "commercial.enrollment.create";
export const ENROLLMENT_UPDATE_ACTION = "commercial.enrollment.update";
/** Every step-up action this screen stashes a draft for (the page discards stale ones on an ordinary visit). */
export const ENROLLMENT_DRAFT_ACTIONS: readonly string[] = [
  ENROLLMENT_CREATE_ACTION,
  ENROLLMENT_UPDATE_ACTION,
];

export type EnrollmentFormMode =
  | { readonly kind: "create"; readonly payers: readonly { id: string; name: string }[] }
  | { readonly kind: "edit"; readonly enrollment: EnrollmentView };

interface Fields {
  payerId: string;
  key: string;
  status: string;
  from: string;
  to: string;
  evidence: string;
}
type FieldErrors = Partial<Record<keyof Fields, string>>;

const FIELD_NAMES: readonly (keyof Fields)[] = [
  "payerId",
  "key",
  "status",
  "from",
  "to",
  "evidence",
];
const isFields = (v: unknown): v is Fields =>
  typeof v === "object" &&
  v !== null &&
  FIELD_NAMES.every((k) => typeof (v as Record<string, unknown>)[k] === "string");

const STATUS_OPTIONS = ENROLLMENT_STATUS_VALUES.map((v) => ({
  value: v,
  label: enrollmentLabel(v),
}));

const initialFields = (mode: EnrollmentFormMode): Fields =>
  mode.kind === "edit"
    ? {
        payerId: mode.enrollment.payerId,
        key: mode.enrollment.clearinghouseKey,
        status: mode.enrollment.status,
        from: mode.enrollment.effectiveFrom,
        to: mode.enrollment.effectiveTo ?? "",
        evidence: mode.enrollment.evidenceRef ?? "",
      }
    : { payerId: "", key: "", status: "pending", from: "", to: "", evidence: "" };

export function EnrollmentForm({
  mode,
  providerEntityId,
  resume,
  onSaved,
  onClose,
  onReload,
}: {
  mode: EnrollmentFormMode;
  providerEntityId: string;
  /** True when the user is genuinely back from /step-up: a stashed draft for this form is restored. */
  resume: boolean;
  onSaved: () => void;
  onClose: () => void;
  onReload: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const editing = mode.kind === "edit";
  const draftKey = stepUpDraftKey(
    owner,
    editing ? ENROLLMENT_UPDATE_ACTION : ENROLLMENT_CREATE_ACTION,
    editing ? mode.enrollment.id : providerEntityId,
  );
  const [fields, setFields] = useState<Fields>(() => {
    const draft = resume ? peekStepUpDraft<unknown>(draftKey) : null;
    // Only the editable fields come back for an edit: payer, clearinghouse and start are the record's own.
    if (!isFields(draft)) return initialFields(mode);
    const base = initialFields(mode);
    return editing
      ? { ...base, status: draft.status, to: draft.to, evidence: draft.evidence }
      : draft;
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<{ text: string; reload: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // One key per submission attempt: kept across a retry of the same body, dropped when a field changes, on success and on a 409.
  const attemptKey = useRef<string | null>(null);

  const edit =
    (name: keyof Fields) =>
    (value: string): void => {
      attemptKey.current = null;
      setFields((prev) => ({ ...prev, [name]: value }));
    };

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!editing) {
      if (!fields.payerId) errors.payerId = "Choose a payer.";
      if (!ENROLLMENT_KEY_PATTERN.test(fields.key)) {
        errors.key =
          "Use 1 to 40 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.";
      }
      if (!fields.from) errors.from = "Enter the first day the enrollment covers.";
    }
    if (!isEnrollmentStatus(fields.status)) errors.status = "Choose a status.";
    if (fields.from && fields.to && fields.to < fields.from) {
      errors.to = "The end date cannot be before the start date.";
    }
    if (fields.evidence && !ENROLLMENT_EVIDENCE_PATTERN.test(fields.evidence)) {
      errors.evidence = "Use 1 to 200 letters, digits and . _ : / # - only, with no spaces.";
    }
    return errors;
  };

  const request = async () => {
    const key = attemptKey.current ?? "";
    const status = isEnrollmentStatus(fields.status) ? fields.status : "pending";
    const header = { "Idempotency-Key": key };
    if (mode.kind === "edit") {
      return client.PATCH("/api/v1/billing/commercial/enrollments/{id}", {
        params: { header, path: { id: mode.enrollment.id } },
        body: {
          providerEntityId,
          status,
          effectiveTo: fields.to || null,
          evidenceRef: fields.evidence || null,
        },
      });
    }
    return client.POST("/api/v1/billing/commercial/enrollments", {
      params: { header },
      body: {
        providerEntityId,
        payerId: fields.payerId,
        clearinghouseKey: fields.key,
        status,
        effectiveFrom: fields.from,
        effectiveTo: fields.to || null,
        evidenceRef: fields.evidence || null,
      },
    });
  };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const errors = validate();
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    inFlight.current = true;
    setBusy(true);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const { error, response } = await request();
      if (!error) {
        attemptKey.current = null;
        clearStepUpDraft(draftKey);
        onSaved();
        return;
      }
      if (response.status === 401) {
        navigate("/login");
        return;
      }
      const stepUp = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
      if (stepUp) {
        // The guard refused before doing anything: a fresh attempt after the ceremony needs a fresh key.
        attemptKey.current = null;
        stashStepUpDraft(draftKey, fields);
        navigate(stepUp);
        return;
      }
      if (response.status === 409) attemptKey.current = null;
      setServerError(describeFailure(response.status, editing));
    } catch {
      setServerError({
        text: "That did not go through. Check your connection and try again.",
        reload: false,
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const cancel = (): void => {
    clearStepUpDraft(draftKey); // closing abandons the draft
    onClose();
  };

  return (
    <form
      className="wx-form-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {mode.kind === "create" ? (
        <>
          <SelectField
            label="Payer"
            required
            value={fields.payerId}
            error={fieldErrors.payerId}
            onChange={(e) => edit("payerId")(e.target.value)}
            options={[
              { value: "", label: "Choose a payer" },
              ...mode.payers.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <TextField
            label="Clearinghouse key"
            required
            autoComplete="off"
            spellCheck={false}
            value={fields.key}
            error={fieldErrors.key}
            hint="The clearinghouse this enrollment is on. Only the platform's clearinghouse lets a send through."
            onChange={(e) => edit("key")(e.target.value)}
          />
          <TextField
            label="Effective from"
            required
            type="date"
            value={fields.from}
            error={fieldErrors.from}
            onChange={(e) => edit("from")(e.target.value)}
          />
        </>
      ) : (
        <p className="wx-row-sub">
          Payer, clearinghouse and start date are fixed. Add a new enrollment to change them.
        </p>
      )}
      <SelectField
        label="Status"
        required
        value={fields.status}
        error={fieldErrors.status}
        hint="Only Enrolled, in effect that day, lets a claim be sent."
        onChange={(e) => edit("status")(e.target.value)}
        options={STATUS_OPTIONS}
      />
      <TextField
        label="Effective to"
        type="date"
        value={fields.to}
        error={fieldErrors.to}
        hint="Leave blank if the enrollment has no end date."
        onChange={(e) => edit("to")(e.target.value)}
      />
      <TextField
        label="Evidence reference"
        autoComplete="off"
        spellCheck={false}
        value={fields.evidence}
        error={fieldErrors.evidence}
        hint="Where the payer's confirmation is kept, for example a document id or a ticket number."
        onChange={(e) => edit("evidence")(e.target.value)}
      />
      {serverError ? (
        <InlineAlert tone="error">
          {serverError.text}
          {serverError.reload ? (
            <>
              {" "}
              <Button tone="tertiary" size="sm" onClick={onReload}>
                Reload list
              </Button>
            </>
          ) : null}
        </InlineAlert>
      ) : null}
      <div className="wx-modal-actions">
        <Button tone="tertiary" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add enrollment"}
        </Button>
      </div>
    </form>
  );
}

function describeFailure(status: number, editing: boolean): { text: string; reload: boolean } {
  if (status === 409) {
    return {
      text: "This period overlaps another enrollment for the same payer and clearinghouse. Reload the list to see what is already recorded.",
      reload: true,
    };
  }
  if (status === 404) {
    return {
      text: editing
        ? "That enrollment or provider entity is not in your scope, or it no longer exists."
        : "The provider entity or payer is not in your scope.",
      reload: false,
    };
  }
  if (status === 422) {
    return {
      text: "These details were not accepted. Check the dates, and that the payer is an active commercial payer.",
      reload: false,
    };
  }
  if (status === 403) {
    return { text: "You are not allowed to manage enrollments.", reload: false };
  }
  return { text: "That did not go through. Check the details and try again.", reload: false };
}
