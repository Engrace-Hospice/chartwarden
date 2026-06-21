// @wardenx/ui — correlation-id-badge (spec §5.1). Shows the correlationId so a user can
// quote it to support; correlationId is the per-request id from the M1 error envelope
// (spec §4.3/§4.5). Click-to-copy is best-effort (clipboard may be unavailable).
import type { JSX } from "react";

export interface CorrelationIdBadgeProps {
  correlationId: string;
}

export function CorrelationIdBadge({ correlationId }: CorrelationIdBadgeProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Copy support reference ${correlationId}`}
      onClick={() => {
        void navigator.clipboard?.writeText(correlationId);
      }}
      style={{
        fontFamily: "monospace",
        fontSize: "0.75rem",
        padding: "0.125rem 0.375rem",
        border: "1px solid #e5e7eb",
        borderRadius: "0.25rem",
        background: "#f9fafb",
        cursor: "pointer",
      }}
    >
      Ref: {correlationId}
    </button>
  );
}
