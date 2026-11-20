// apps/web/src/modules/08-encounters/review — the places in the visit note a blocker or a review row can send the author to. The panels
// are presentational: they name a target and the screen that hosts them (the composer, the record) moves focus there or navigates.
// Keeping the targets in one union is what lets the blocker panel, the review summary and the host agree on what "go to it" means.

/** The template section a visit reason is recorded in, and where a fall follow-up is linked (the one place both words are written). */
export const VISIT_REASON_SECTION_ID = "chief_concern";

/** The vitals the server names in a `MISSING_VITAL` detail (its `VitalField` vocabulary). */
export const VITAL_KEYS = [
  "bp",
  "heartRate",
  "respiratoryRate",
  "temperature",
  "spo2",
  "pain",
] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

/** The scales the server names in a `MISSING_SCALE` detail. */
export const SCALE_KEYS = ["pps", "esas_r"] as const;
export type ScaleKey = (typeof SCALE_KEYS)[number];

export type NoteTarget =
  /** A template section: its fields, its selections and its own text. */
  | { readonly kind: "section"; readonly sectionId: string }
  /** The visit vitals panel, with the vital that is missing when the server named one. */
  | { readonly kind: "vitals"; readonly vital?: VitalKey }
  /** Where PPS and ESAS-r are recorded (the patient's assessments). */
  | { readonly kind: "scales"; readonly scale: ScaleKey }
  /** The patient's care plan, to review it. */
  | { readonly kind: "care_plan_review" }
  /** The plan-of-care step of the note: the care-plan items linked to this visit. */
  | { readonly kind: "plan_step" }
  /** A drafted section's card, to confirm or deselect it. */
  | { readonly kind: "draft_section"; readonly sectionId: string }
  /** The late-entry reason input. */
  | { readonly kind: "late_entry_reason" }
  /** Save the selections again (a vocabulary change under the draft). */
  | { readonly kind: "save_selections" }
  /** The author's edit of the note text, to review or discard. */
  | { readonly kind: "note_text" }
  /** Sign in again (the step-up). */
  | { readonly kind: "reauthenticate" }
  /** My Notes, where overdue notes are closed. */
  | { readonly kind: "my_notes" }
  /** The note itself, when the server's refusal names nothing more specific. */
  | { readonly kind: "open_note" }
  /** Nothing the author can do in the app (another person's override, an administrator's assignment). */
  | { readonly kind: "none" };

export type HeadingOf = (sectionId: string) => string;

/** The text of the button that takes the author to `target`, or null when there is nowhere to go. */
export function targetLabel(target: NoteTarget, headingOf: HeadingOf): string | null {
  switch (target.kind) {
    case "section":
      return `Go to ${headingOf(target.sectionId)}`;
    case "draft_section":
      return `Review ${headingOf(target.sectionId)}`;
    case "vitals":
      return "Open visit vitals";
    case "scales":
      return "Open assessments";
    case "care_plan_review":
      return "Open care plan";
    case "plan_step":
      return "Open plan of care";
    case "late_entry_reason":
      return "Enter the late-entry reason";
    case "save_selections":
      return "Save the selections again";
    case "note_text":
      return "Review the note text";
    case "reauthenticate":
      return "Sign in again";
    case "my_notes":
      return "Open My Notes";
    case "open_note":
      return "Open the note";
    case "none":
      return null;
  }
}
