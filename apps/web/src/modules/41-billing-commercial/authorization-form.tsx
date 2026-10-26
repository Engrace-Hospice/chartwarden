// apps/web/src/modules/41-billing-commercial — RECORD A PRE-AUTHORIZATION (M41). The form in the authorizations drawer.
//   POST /api/v1/billing/commercial/authorizations   (Idempotency-Key per submission attempt)
// The authorization number is the only secret-like field: it is autofill-off, lives only in this component's state, is cleared after
// a success, and is never put in the URL, a ceremony draft or a log. Client checks only mirror the server (number pattern, end date
// not before start, a plan chosen); the server stays the authority and its 404 / 409 / 422 are shown inline.
import { Button, InlineAlert, SelectField, TextField, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { authFailureRedirect } from "../23-billing-medicare/write-workflow";
import {
  AUTHORIZATION_NUMBER_PATTERN,
  type AuthorizationPlan,
  LEVEL_OF_CARE_OPTIONS,
  levelOfCareLabel,
} from "./commercial-model";

type LevelOfCare = (typeof LEVEL_OF_CARE_OPTIONS)[number];
const isLevelOfCare = (value: string): value is LevelOfCare =>
  (LEVEL_OF_CARE_OPTIONS as readonly string[]).includes(value);

interface FieldErrors {
  plan?: string;
  number?: string;
  obtainedOn?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export function AuthorizationForm({
  providerEntityId,
  patientId,
  plans,
  onRecorded,
  onClose,
  onReload,
}: {
  providerEntityId: string;
  patientId: string;
  plans: readonly AuthorizationPlan[];
  onRecorded: () => void;
  onClose: () => void;
  onReload: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [planId, setPlanId] = useState("");
  const [level, setLevel] = useState("");
  const [number, setNumber] = useState("");
  const [obtainedOn, setObtainedOn] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<{ text: string; reload: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // One key per submission attempt: kept across a retry of the same body, dropped when a field changes and on any HTTP response; kept only after a thrown/no-response failure.
  const attemptKey = useRef<string | null>(null);

  const edit =
    (set: (value: string) => void) =>
    (value: string): void => {
      attemptKey.current = null;
      set(value);
    };

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!planId) errors.plan = "Choose a plan.";
    if (!AUTHORIZATION_NUMBER_PATTERN.test(number)) {
      errors.number = "Use 1 to 50 letters, digits, dots, underscores and hyphens.";
    }
    if (!obtainedOn) errors.obtainedOn = "Enter the date the authorization was obtained.";
    if (!effectiveFrom) errors.effectiveFrom = "Enter the first day it covers.";
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      errors.effectiveTo = "The end date cannot be before the start date.";
    }
    return errors;
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
      const { error, response } = await client.POST("/api/v1/billing/commercial/authorizations", {
        params: { header: { "Idempotency-Key": attemptKey.current } },
        body: {
          providerEntityId,
          patientId,
          planId,
          authorizationNumber: number,
          levelOfCare: isLevelOfCare(level) ? level : null,
          obtainedOn,
          effectiveFrom,
          effectiveTo: effectiveTo || null,
        },
      });
      if (!error) {
        attemptKey.current = null;
        setNumber("");
        onRecorded();
        return;
      }
      // The server caches EVERY answer (4xx/5xx too) under the key for 24h and replays it for the same body, so a key survives only
      // when no HTTP response arrived (the catch below); any response, 503/500/403/404/422 included, retires it.
      attemptKey.current = null;
      const env = (error as { error?: { code?: string } }).error;
      const redirect = authFailureRedirect(
        response.status,
        env?.code,
        window.location.pathname + window.location.search,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      setServerError(describeFailure(response.status));
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

  return (
    <form
      className="wx-form-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SelectField
        label="Plan"
        required
        value={planId}
        error={fieldErrors.plan}
        onChange={(e) => edit(setPlanId)(e.target.value)}
        options={[
          { value: "", label: "Choose a plan" },
          ...plans.map((p) => ({ value: p.id, label: p.planName })),
        ]}
      />
      <SelectField
        label="Level of care"
        value={level}
        hint="Leave blank for every level of care."
        onChange={(e) => edit(setLevel)(e.target.value)}
        options={[
          { value: "", label: "Every level of care" },
          ...LEVEL_OF_CARE_OPTIONS.map((l) => ({ value: l, label: levelOfCareLabel(l) })),
        ]}
      />
      <TextField
        label="Authorization number"
        required
        autoComplete="off"
        spellCheck={false}
        value={number}
        error={fieldErrors.number}
        hint="Stored for the payer, but never shown again."
        onChange={(e) => edit(setNumber)(e.target.value)}
      />
      <TextField
        label="Obtained on"
        required
        type="date"
        value={obtainedOn}
        error={fieldErrors.obtainedOn}
        onChange={(e) => edit(setObtainedOn)(e.target.value)}
      />
      <TextField
        label="Effective from"
        required
        type="date"
        value={effectiveFrom}
        error={fieldErrors.effectiveFrom}
        onChange={(e) => edit(setEffectiveFrom)(e.target.value)}
      />
      <TextField
        label="Effective to"
        type="date"
        value={effectiveTo}
        error={fieldErrors.effectiveTo}
        hint="Leave blank if the authorization has no end date."
        onChange={(e) => edit(setEffectiveTo)(e.target.value)}
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
        <Button tone="tertiary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Recording…" : "Record authorization"}
        </Button>
      </div>
    </form>
  );
}

function describeFailure(status: number): { text: string; reload: boolean } {
  if (status === 409) {
    return {
      text: "An authorization with these details may already be recorded. If you are retrying after an error, reload the list to check before recording it again.",
      reload: true,
    };
  }
  if (status === 404) {
    return {
      text: "The patient or entity is not in your scope, or the patient has no admission under this entity.",
      reload: false,
    };
  }
  if (status === 422) {
    return { text: "The end date cannot be before the start date.", reload: false };
  }
  if (status === 403) {
    return { text: "You are not allowed to record authorizations.", reload: false };
  }
  return { text: "That did not go through. Check the details and try again.", reload: false };
}
