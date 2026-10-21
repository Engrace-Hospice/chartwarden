// apps/web/src/modules/06-admission — hold / resume an admission (POST /api/v1/admissions/:id/hold and
// /resume; GAP-021). The reason is required on hold (server: 10-500 chars); both writes carry the
// optimistic-lock `ifVersion`. The server enforces `admission.hold` + scope — this only shapes the request.
import { Button, InlineAlert, TextAreaField, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

export const HOLD_REASON_MIN_CHARS = 10;
export const HOLD_REASON_MAX_CHARS = 500;

export interface AdmissionHoldActionProps {
  admissionId: string;
  state: string;
  version: number;
  /** Called after a successful hold/resume so the page reloads the admission. */
  onChanged: () => void;
}

const REFUSAL_MESSAGE: Record<string, string> = {
  VERSION_CONFLICT: "This admission changed since it was loaded. Reload and try again.",
};

function messageFor(error: unknown, fallback: string): string {
  const code = (error as { error?: { code?: unknown } } | undefined)?.error?.code;
  return (typeof code === "string" && REFUSAL_MESSAGE[code]) || fallback;
}

export function AdmissionHoldAction({
  admissionId,
  state,
  version,
  onChanged,
}: AdmissionHoldActionProps): JSX.Element | null {
  const client = useApiClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state !== "active" && state !== "on_hold") return null;

  async function resume(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: err } = await client.POST("/api/v1/admissions/{id}/resume", {
      params: { path: { id: admissionId } },
      body: { ifVersion: version },
    });
    setBusy(false);
    if (err) return setError(messageFor(err, "Could not resume the admission."));
    onChanged();
  }

  async function hold(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await client.POST("/api/v1/admissions/{id}/hold", {
      params: { path: { id: admissionId } },
      body: { reason: reason.trim(), ifVersion: version },
    });
    setBusy(false);
    if (err) return setError(messageFor(err, "Could not place the admission on hold."));
    setOpen(false);
    setReason("");
    onChanged();
  }

  const reasonReady = reason.trim().length >= HOLD_REASON_MIN_CHARS;

  return (
    <>
      {state === "on_hold" ? (
        <Button type="button" tone="secondary" loading={busy} onClick={() => void resume()}>
          Resume admission
        </Button>
      ) : open ? (
        <form className="wx-action-body" onSubmit={(e) => void hold(e)}>
          <TextAreaField
            label="Reason"
            required
            rows={2}
            maxLength={HOLD_REASON_MAX_CHARS}
            value={reason}
            hint={`At least ${HOLD_REASON_MIN_CHARS} characters.`}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="wx-action-row is-end">
            <Button type="button" tone="tertiary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!reasonReady} loading={busy}>
              Confirm hold
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" tone="secondary" onClick={() => setOpen(true)}>
          Place on hold
        </Button>
      )}
      {error ? <InlineAlert>{error}</InlineAlert> : null}
    </>
  );
}
