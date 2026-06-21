// @wardenx/ui — empty-state (spec §5.1). Shown when a list/query has no rows.
import type { JSX, ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional call-to-action (e.g. a button) rendered below the description. */
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div role="note" style={{ textAlign: "center", padding: "2rem", color: "#6b7280" }}>
      <p style={{ fontWeight: 600, margin: 0 }}>{title}</p>
      {description ? <p style={{ margin: "0.5rem 0 0" }}>{description}</p> : null}
      {action ? <div style={{ marginTop: "1rem" }}>{action}</div> : null}
    </div>
  );
}
