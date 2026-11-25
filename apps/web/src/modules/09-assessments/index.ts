// apps/web/src/modules/09-assessments — M9 Clinical Assessments Suite web slice (Track B, ADR-0030).
// Built in M9-T07 against M9's generated client methods (packages/ui/src/core/api).
export { assessmentScreens } from "./screens";
// The visit note's wound panel: mounted by the note composer (08-encounters), which owns the note; wounds are M9's record.
export { VisitWoundsPanel } from "./wounds/visit-wounds-panel";
export type { VisitWoundsPanelProps } from "./wounds/visit-wounds-panel";
// The panel's "No skin or wound concerns at this visit" statement: the composer holds it in the section's free text.
export {
  NO_WOUND_CONCERNS_SENTENCE,
  noWoundConcernsState,
  withoutNoWoundConcerns,
} from "./wounds/no-wound-concerns";
export type { NoWoundConcernsChange, NoWoundConcernsState } from "./wounds/no-wound-concerns";
