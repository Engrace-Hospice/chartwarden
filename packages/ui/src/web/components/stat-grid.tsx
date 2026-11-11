// @chartwarden/ui web — a labelled group of stat cards (`.wx-stat-card`s in a `.wx-stat-grid`).
// A named group of cards is not a form's field set: `<fieldset>` would announce "group" for a form it is not, and its default
// min-width stops the grid shrinking. `role="group"` + `aria-label` names the cards without either.
import type { JSX, ReactNode } from "react";

export interface StatGridProps {
  /** The group's accessible name, e.g. "Outbox summary". */
  label: string;
  /** Defaults to the shared `.wx-stat-grid`; a screen with its own column count passes its class (e.g. `wx-work-summary`). */
  className?: string;
  children: ReactNode;
}

export function StatGrid({
  label,
  className = "wx-stat-grid",
  children,
}: StatGridProps): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: not a form's field set — <fieldset> would announce a form group and sets min-width: min-content, which stops the grid shrinking
    <div role="group" aria-label={label} className={className}>
      {children}
    </div>
  );
}
