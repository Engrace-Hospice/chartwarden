// apps/web/src/modules/08-encounters — what the composer says when finalizing is refused for drafted sections (ADR-0114 VN-D7, S1 PR D).
// Moved out of encounter-compose.tsx unchanged. The gate lists every failure at once: the drafted sections are named beside the draft strip,
// and the first other failure is repeated in the page's own feedback.
import { type UiFeedback, readableValidation } from "./compose-feedback";
import { describeIssues, draftGateRefusal } from "./draft-model";

export interface GateRefusalWords {
  /** The drafted sections the gate named, in words, for the draft strip. */
  readonly refusal: string;
  readonly feedback: UiFeedback;
}

/** The refusal's words, or null when the gate named no drafted section (the refusal is then not about the draft). */
export function gateRefusalWords(
  details: unknown,
  headingOf: (sectionId: string) => string,
): GateRefusalWords | null {
  const gate = draftGateRefusal(details);
  if (!gate) return null;
  const alsoNeeded = gate.others.length > 0 ? ` Also: ${readableValidation(gate.others, "")}` : "";
  return {
    refusal: describeIssues(gate.issues, headingOf),
    feedback: {
      tone: "error",
      title: "Drafted sections need your review",
      message: `The note was not finalized. Confirm or deselect the sections listed under the progress summary, then finalize again.${alsoNeeded}`,
    },
  };
}
