// packages/ui/src/web/system — the activatable data row (#32).
//
// A `<tr>` that opens a detail drawer on click is a CONTROL, but the element itself is not one: it
// is not a link or a button, so it never enters the tab order, and a keyboard user cannot reach the
// panel behind it at all. WCAG 2.1 2.1.1 Keyboard is Level A — the drawer is simply unavailable.
//
// The repo already had the correct shape written out by hand twice (24-billing-medicaid
// claim-workbench.tsx, 33-reporting reporting-schedules.tsx) and missing from five other rows. That
// asymmetry is the defect: the pattern was known and applied inconsistently. This helper exists so
// the next such row cannot be written wrong, and so `scripts/check-interactive-rows.ts` has a single
// shape to recognise.
//
// TWO SHAPES, AND WHY THEY DIFFER
//
// `role="button"` is the better announcement: a screen-reader user tabbing onto a bare row is told
// nothing about what Enter would do, and `aria-pressed` reports which row is currently open — the
// state the selected-row background conveys visually and otherwise not at all.
//
// But a `button` MUST NOT contain focusable content. Three of the rows this was written for hold
// their own links or action menus (a plan link, a staff action dropdown); wrapping those in
// `role="button"` produces an invalid accessibility tree, where the nested control may not be
// exposed and the button's name is computed from the whole row's text. Those rows therefore stay
// plain rows that happen to be focusable and activatable — which is exactly what the pre-existing
// `claim-workbench.tsx` precedent does. The difference is a consequence of the row's contents, not
// another inconsistency.
import type { KeyboardEvent } from "react";

export interface InteractiveRowProps {
  /** omitted for rows that contain their own controls — see the note above */
  role?: "button";
  tabIndex: 0;
  "aria-pressed"?: boolean;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Props for a table row that activates like a button.
 *
 * Spread onto the `<tr>`, alongside `className="wx-data-row-interactive"` — whose `:focus-visible`
 * rule in apps/web/src/index.css supplies the focus ring, and which could never render before
 * because nothing in the row was focusable.
 *
 * @param onActivate       what the row does — the same callback the pointer path uses
 * @param selected         whether this row's detail is the one currently open
 * @param containsControls set when the row holds its own links or buttons, which forbids the
 *                         `role="button"` announcement (a button may not wrap focusable content)
 */
export function interactiveRowProps(
  onActivate: () => void,
  selected = false,
  containsControls = false,
): InteractiveRowProps {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // A keystroke aimed at a link or button INSIDE the row belongs to that control, not to the row.
    // Without this, Enter on a nested link both follows the link and opens the drawer.
    if (event.target !== event.currentTarget) return;
    // Space scrolls a focused element by default: without this the drawer opens and the surface
    // jumps under the user in the same keystroke. Enter is prevented for symmetry — a row inside a
    // form must not submit it.
    event.preventDefault();
    onActivate();
  };
  if (containsControls) return { tabIndex: 0, onClick: onActivate, onKeyDown };
  return {
    role: "button",
    tabIndex: 0,
    "aria-pressed": selected,
    onClick: onActivate,
    onKeyDown,
  };
}
