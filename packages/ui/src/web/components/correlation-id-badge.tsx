// @chartwarden/ui — correlation-id-badge (spec §5.1). Shows the correlationId so a user can
// quote it to support; correlationId is the per-request id from the M1 error envelope
// (spec §4.3/§4.5). Click-to-copy is best-effort (clipboard may be unavailable).
// Lantern (DESIGN.md §3.1): correlationId is a code → IBM Plex Mono on a tonal surface, no line.
import type { JSX } from "react";
import { t } from "../theme/tokens";

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
        fontFamily: t.fontMono,
        fontSize: "0.75rem",
        padding: "0.125rem 0.375rem",
        border: "none",
        borderRadius: t.radiusSm,
        background: t.surfaceLow,
        color: t.onSurfaceVariant,
        cursor: "pointer",
      }}
    >
      Ref: {correlationId}
    </button>
  );
}
