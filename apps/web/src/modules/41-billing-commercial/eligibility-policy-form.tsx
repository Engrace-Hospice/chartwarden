// apps/web/src/modules/41-billing-commercial — EDIT A PLAN'S ELIGIBILITY POLICY (M41). The form in the eligibility screen's drawer.
//   PATCH /api/v1/billing/commercial/payer-plans/{id}/eligibility-policy   { policy: warn | block, maxAgeDays: 1..365 }
//         (manage_enrollment, FRESH step-up, Idempotency-Key per attempt)
// Relaxing the policy weakens a billing control, so the write needs a fresh step-up. A refusal stashes what was typed under the shared
// step-up draft key and sends the user to /step-up; on return the form is restored and the user submits again, nothing is sent for
// them. The client check mirrors the server (a whole number of days, 1 to 365); the server stays the authority and its answers are
// shown in fixed words, never echoed.
import { Button, InlineAlert, SelectField, TextField, useApiClient } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  type StepUpDraftOwner,
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import {
  ELIGIBILITY_POLICY_VALUES,
  type EligibilityPolicyValue,
  MAX_ELIGIBILITY_MAX_AGE_DAYS,
  eligibilityPolicyLabel,
  isEligibilityPolicy,
  parseMaxAgeDays,
} from "./commercial-model";

export const ELIGIBILITY_POLICY_ACTION = "commercial.eligibility.policy";
export const ELIGIBILITY_DRAFT_ACTIONS: readonly string[] = [ELIGIBILITY_POLICY_ACTION];

/** The step-up draft key of the policy form for `planId`. */
export const eligibilityPolicyDraftKey = (owner: StepUpDraftOwner, planId: string): string | null =>
  stepUpDraftKey(owner, ELIGIBILITY_POLICY_ACTION, planId);

export interface SavedPolicy {
  readonly policy: EligibilityPolicyValue;
  readonly maxAgeDays: number;
}

interface Fields {
  policy: string;
  maxAgeDays: string;
}
type FieldErrors = Partial<Record<keyof Fields, string>>;

const isFields = (v: unknown): v is Fields =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Record<string, unknown>).policy === "string" &&
  typeof (v as Record<string, unknown>).maxAgeDays === "string";

const POLICY_OPTIONS = ELIGIBILITY_POLICY_VALUES.map((v) => ({
  value: v,
  label: eligibilityPolicyLabel(v),
}));

function describeFailure(status: number): string {
  if (status === 409) return "This request clashed with an earlier one. Save again.";
  if (status === 404) return "That plan is not in your scope, or it no longer exists.";
  if (status === 403) return "You are not allowed to change eligibility policies.";
  if (status === 422) {
    return `These details were not accepted. Use a whole number of days from 1 to ${MAX_ELIGIBILITY_MAX_AGE_DAYS}.`;
  }
  return "That did not go through. Check your connection and try again.";
}

export function EligibilityPolicyForm({
  providerEntityId,
  planId,
  current,
  resume,
  onSaved,
  onClose,
}: {
  providerEntityId: string;
  planId: string;
  /** The plan's policy as last read; the form starts here. */
  current: { policy: string; maxAgeDays: number };
  /** True when the user is genuinely back from /step-up: a stashed draft for this plan is restored. */
  resume: boolean;
  onSaved: (saved: SavedPolicy) => void;
  onClose: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const draftKey = eligibilityPolicyDraftKey(owner, planId);
  const [fields, setFields] = useState<Fields>(() => {
    const draft = resume ? peekStepUpDraft<unknown>(draftKey) : null;
    return isFields(draft)
      ? draft
      : { policy: current.policy, maxAgeDays: String(current.maxAgeDays) };
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // One key per attempt: kept across a retry of the same body, dropped when a field changes, on success, on a 409 and on step-up.
  const attemptKey = useRef<string | null>(null);

  const edit =
    (name: keyof Fields) =>
    (value: string): void => {
      attemptKey.current = null;
      setFields((prev) => ({ ...prev, [name]: value }));
    };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const errors: FieldErrors = {};
    const policy = isEligibilityPolicy(fields.policy) ? fields.policy : null;
    const maxAgeDays = parseMaxAgeDays(fields.maxAgeDays);
    if (!policy) errors.policy = "Choose what a stale check does.";
    if (maxAgeDays === null) {
      errors.maxAgeDays = `Enter a whole number of days from 1 to ${MAX_ELIGIBILITY_MAX_AGE_DAYS}.`;
    }
    setFieldErrors(errors);
    setServerError(null);
    if (!policy || maxAgeDays === null) return;
    inFlight.current = true;
    setBusy(true);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const { error, response } = await client.PATCH(
        "/api/v1/billing/commercial/payer-plans/{id}/eligibility-policy",
        {
          params: { path: { id: planId }, header: { "Idempotency-Key": attemptKey.current } },
          body: { policy, maxAgeDays },
        },
      );
      if (!error) {
        attemptKey.current = null;
        clearStepUpDraft(draftKey);
        onSaved({ policy, maxAgeDays });
        return;
      }
      if (response.status === 401) {
        navigate("/login");
        return;
      }
      // The resolved entity goes into the return URL so the restored page is scoped the same way.
      const back = new URLSearchParams(location.search);
      if (!back.has("entity")) back.set("entity", providerEntityId);
      const stepUp = stepUpRedirectFor(error, `${location.pathname}?${back.toString()}`);
      if (stepUp) {
        // The guard refused before doing anything: a fresh attempt after the ceremony needs a fresh key.
        attemptKey.current = null;
        stashStepUpDraft(draftKey, fields);
        navigate(stepUp);
        return;
      }
      if (response.status === 409) attemptKey.current = null;
      setServerError(describeFailure(response.status));
    } catch {
      setServerError(describeFailure(0));
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
      <SelectField
        label="When the latest check is stale or missing"
        required
        value={fields.policy}
        error={fieldErrors.policy}
        hint="A fresh answer of Inactive always blocks, whatever this says."
        onChange={(e) => edit("policy")(e.target.value)}
        options={POLICY_OPTIONS}
      />
      <TextField
        label="Stale after (days)"
        required
        inputMode="numeric"
        autoComplete="off"
        value={fields.maxAgeDays}
        error={fieldErrors.maxAgeDays}
        hint={`A check older than this many days is stale. 1 to ${MAX_ELIGIBILITY_MAX_AGE_DAYS}.`}
        onChange={(e) => edit("maxAgeDays")(e.target.value)}
      />
      {serverError ? <InlineAlert tone="error">{serverError}</InlineAlert> : null}
      <div className="wx-modal-actions">
        <Button tone="tertiary" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </form>
  );
}
