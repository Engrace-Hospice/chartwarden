// @wardenx/ui — ErrorState (UI-002), split out of `EmptyState`. A failed fetch and a genuinely empty
// list are different facts: one is announced (`role="alert"`) and offers a retry, the other is a
// quiet, editorial "there's nothing here yet" (`EmptyState`, `role="note"`). Wire `onRetry` to the
// same `load()` the screen already calls on mount.
import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";

export interface ErrorStateProps {
  title?: string;
  description?: string;
  /** Re-runs the failed fetch. Renders a Retry button wired to this callback. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Additional call-to-action rendered alongside Retry (e.g. a "Contact support" link). */
  action?: ReactNode;
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Retry",
  action,
}: ErrorStateProps): JSX.Element {
  return (
    <div role="alert" style={{ textAlign: "center", padding: "2rem", color: t.onSurfaceVariant }}>
      <p
        style={{
          fontFamily: t.fontDisplay,
          fontSize: "1.375rem",
          fontWeight: 500,
          margin: 0,
          color: t.onSurface,
        }}
      >
        {title}
      </p>
      {description ? <p style={{ margin: "0.5rem 0 0" }}>{description}</p> : null}
      {onRetry || action ? (
        <div
          style={{
            marginTop: "1rem",
            display: "flex",
            gap: "0.5rem",
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: "0.5rem 1rem",
                borderRadius: t.radiusMd,
                border: "none",
                background: t.surfaceHigh,
                color: t.onSurface,
                fontWeight: 600,
                fontSize: "0.8125rem",
                cursor: "pointer",
              }}
            >
              {retryLabel}
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
