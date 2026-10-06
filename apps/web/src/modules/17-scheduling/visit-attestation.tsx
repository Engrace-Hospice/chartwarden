// GAP-050 (M17) — starting or checking in to a visit is now a self-attestation. The server always
// requires `evvMissingReason` (40..1000 chars), a fresh step-up, and that the caller is the assigned
// clinician. EVV bracket advance comes from the device, so there is no "EVV present" path from the UI.
import type { CSSProperties, JSX } from "react";

export const EVV_REASON_MIN_LENGTH = 40;
export const EVV_REASON_MAX_LENGTH = 1000;

const ASSIGNED_CLINICIAN_CODE = "ASSIGNED_CLINICIAN_REQUIRED";

export const ASSIGNED_CLINICIAN_MESSAGE =
  "Only the clinician assigned to this visit can start it or check in. Ask the scheduler to reassign the visit if it is yours.";

/** A user-facing problem with the reason, or null when it is acceptable. */
export function evvReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < EVV_REASON_MIN_LENGTH)
    return `Explain why there is no EVV bracket in at least ${EVV_REASON_MIN_LENGTH} characters (${length}/${EVV_REASON_MIN_LENGTH}).`;
  if (length > EVV_REASON_MAX_LENGTH)
    return `The reason is too long: ${EVV_REASON_MAX_LENGTH} characters at most (${length}/${EVV_REASON_MAX_LENGTH}).`;
  return null;
}

/** True when the refusal is the 403 "you are not the assigned clinician" (any of the error envelopes). */
export function isAssignedClinicianRefusal(error: unknown): boolean {
  const body = error as {
    code?: string;
    message?: string;
    error?: { code?: string; message?: string };
  } | null;
  return [body?.code, body?.message, body?.error?.code, body?.error?.message].includes(
    ASSIGNED_CLINICIAN_CODE,
  );
}

const fieldStyle: CSSProperties = { display: "grid", gap: "0.375rem" };
const labelStyle: CSSProperties = { fontSize: "0.8125rem", fontWeight: 600 };
const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.625rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
  font: "inherit",
};
const hintStyle: CSSProperties = { margin: 0, fontSize: "0.75rem" };

export function EvvReasonField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const problem = value.length > 0 ? evvReasonProblem(value) : null;
  return (
    <div style={fieldStyle}>
      <label style={fieldStyle}>
        <span style={labelStyle}>Reason there is no EVV bracket (required)</span>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          maxLength={EVV_REASON_MAX_LENGTH + 200}
          disabled={disabled}
          aria-invalid={problem !== null}
          aria-describedby="evv-reason-hint"
          style={textareaStyle}
        />
      </label>
      <p id="evv-reason-hint" style={hintStyle} role={problem ? "alert" : undefined}>
        {problem ??
          `${value.trim().length}/${EVV_REASON_MAX_LENGTH} characters (minimum ${EVV_REASON_MIN_LENGTH}). This is recorded as your attestation for the EVV audit trail.`}
      </p>
    </div>
  );
}
