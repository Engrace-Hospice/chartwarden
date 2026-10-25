// apps/web/src/modules/41-billing-commercial — the validation panel of a commercial claim (M41, issue #726). Every rule of the
// latest run with its severity and the actionable message the server wrote. A SOFT block (overridable) can be overridden with a
// reason of at least 40 characters; a HARD block cannot, only a data or policy change clears it. The override needs a fresh
// step-up: a step-up denial sends the user to /step-up and back, and the reason survives the round trip in the in-memory ceremony
// draft store (never browser storage: a reason can carry PHI). Messages are server text; this panel never logs them.
import { COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH } from "@chartwarden/types";
import { Button, InlineAlert, StatusPill, TextAreaField, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { clearDraft, loadDraft, saveDraft } from "../../shell/ceremony-drafts";
import { authFailureRedirect } from "../23-billing-medicare/write-workflow";
import {
  type ValidationResultFact,
  resultLabel,
  resultTone,
  statusLabel,
} from "./commercial-model";

export const OVERRIDE_REASON_MIN_LENGTH = COMMERCIAL_OVERRIDE_REASON_MIN_LENGTH;

export interface ValidationRun {
  readonly runId: string;
  readonly outcome: string;
  readonly results: readonly ValidationResultFact[];
}

const draftKey = (claimId: string, resultId: string): string =>
  `m41-override:${claimId}:${resultId}`;

export function ValidationPanel({
  claimId,
  validation,
  canOverride,
  onChanged,
}: {
  claimId: string;
  validation: ValidationRun | null;
  canOverride: boolean;
  onChanged: () => void;
}): JSX.Element {
  if (validation === null) {
    return (
      <p className="wx-row-sub">
        No validation has run yet. Use Re-validate to check the claim against the plan's rules.
      </p>
    );
  }
  return (
    <ul className="wx-checklist" aria-label="Validation results">
      {validation.results.map((r) => (
        <li key={r.id} className="wx-action-row">
          <div className="wx-action-body">
            <div className="wx-action-title">
              {statusLabel(r.ruleKey)} <StatusPill label={resultLabel(r)} tone={resultTone(r)} />
            </div>
            {r.outcome === "pass" ? null : <p className="wx-action-hint">{r.message}</p>}
            {canOverride && r.outcome === "fail" && r.overridable && !r.overridden ? (
              <OverrideForm
                claimId={claimId}
                resultId={r.id}
                ruleLabel={statusLabel(r.ruleKey)}
                onDone={onChanged}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function OverrideForm({
  claimId,
  resultId,
  ruleLabel,
  onDone,
}: {
  claimId: string;
  resultId: string;
  ruleLabel: string;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const key = draftKey(claimId, resultId);
  const restored = loadDraft<string>(key);
  const [open, setOpen] = useState(restored !== undefined);
  const [reason, setReason] = useState(restored ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = reason.trim().length;
  const long = length >= OVERRIDE_REASON_MIN_LENGTH;
  const form = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const opened = useRef(false);

  // Opening swaps the trigger for the form: focus the reason; closing hands focus back to the trigger.
  useEffect(() => {
    if (open) {
      form.current?.querySelector("textarea")?.focus();
      opened.current = true;
    } else if (opened.current) {
      trigger.current?.querySelector("button")?.focus();
    }
  }, [open]);

  if (!open) {
    return (
      <span ref={trigger}>
        <Button tone="secondary" size="sm" onClick={() => setOpen(true)}>
          Override {ruleLabel}
        </Button>
      </span>
    );
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    saveDraft(key, reason);
    try {
      const { error: err, response } = await client.POST(
        "/api/v1/billing/commercial/claims/{id}/validation-results/{resultId}/override",
        {
          params: {
            path: { id: claimId, resultId },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: { reason: reason.trim() },
        },
      );
      if (err) {
        const code = (err as { error?: { code?: string } }).error?.code;
        const redirect = authFailureRedirect(
          response.status,
          code,
          window.location.pathname + window.location.search,
        );
        if (redirect) {
          navigate(redirect);
          return;
        }
        setError(
          response.status === 403
            ? "You are not allowed to override this rule."
            : "The override was not recorded. Reload the claim and try again.",
        );
        return;
      }
      clearDraft(key);
      onDone();
    } catch {
      setError("The override was not recorded. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={form}
      className="wx-form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (long && !busy) void submit();
      }}
    >
      <TextAreaField
        label={`Reason to override ${ruleLabel}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint={`${length} of ${OVERRIDE_REASON_MIN_LENGTH} characters. Recorded in the audit trail; do not include patient identifiers.`}
        rows={3}
      />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="wx-modal-actions">
        <Button
          tone="tertiary"
          size="sm"
          onClick={() => {
            clearDraft(key);
            setReason("");
            setOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!long || busy}>
          {busy ? "Recording…" : "Record override"}
        </Button>
      </div>
    </form>
  );
}
