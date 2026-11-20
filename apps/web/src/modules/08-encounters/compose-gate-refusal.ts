// apps/web/src/modules/08-encounters — what the composer says beside the draft strip when finalizing is refused for drafted sections
// (ADR-0114 VN-D7, S1 PR D). The gate lists every failure at once; the drafted sections it named are said in words here, and the whole
// list (these and every other blocker) is the blocker panel's (WF09 WP3), the one live region for the gate's refusals.
import { describeIssues, draftGateRefusal } from "./draft-model";

export interface GateRefusalWords {
  /** The drafted sections the gate named, in words, for the draft strip. */
  readonly refusal: string;
}

/** The refusal's words, or null when the gate named no drafted section (the refusal is then not about the draft). */
export function gateRefusalWords(
  details: unknown,
  headingOf: (sectionId: string) => string,
): GateRefusalWords | null {
  const gate = draftGateRefusal(details);
  if (!gate) return null;
  return { refusal: describeIssues(gate.issues, headingOf) };
}
