// apps/web/src/modules/08-encounters/workspace — the Review and Complete steps move within the page, not through the router: a router
// navigation to a hash would meet the composer's "Leave without saving?" guard for nothing, and would re-run the record's read.
/** The id the Review step goes to: the note as it reads (the composer's preview card, the record's Documentation panel). */
export const REVIEW_ANCHOR_ID = "visit-review";
/** The id the Complete step goes to: what finalizes and signs the note (the composer's finalize region, the record's quick actions). */
export const COMPLETE_ANCHOR_ID = "visit-complete";

/** Scrolls to the element and moves keyboard focus to it (it needs `tabIndex={-1}`); false when this page has no such element. */
export function jumpToAnchor(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView?.({ block: "start" });
  target.focus({ preventScroll: true });
  return true;
}
