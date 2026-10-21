// @chartwarden/ui — empty-state (spec §5.1). Shown when a list/query has no rows.
// Lantern (DESIGN.md §3.1): empty states are a Fraunces "human moment"; body in muted on-surface.
import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional call-to-action (e.g. a button) rendered below the description. */
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div role="note" style={{ textAlign: "center", padding: "2rem", color: t.onSurfaceVariant }}>
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
      {action ? <div style={{ marginTop: "1rem" }}>{action}</div> : null}
    </div>
  );
}
