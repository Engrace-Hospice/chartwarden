// apps/web/src/modules/08-encounters — what the composer says beside the draft strip when finalizing is refused for drafted sections
// (ADR-0114 VN-D7, S1 PR D). The gate lists every failure at once; the drafted sections it named are said in words here, and the whole
// list (these and every other blocker) is the blocker panel's (WF09 WP3), the one live region for the gate's refusals. The words are
// DERIVED from the refused attempt the panel shows, so the two cannot name different sections.
import { describeIssues, draftIssuesFrom } from "./draft-model";
import type { GateAttempt } from "./review";

/** The drafted sections the attempt's refusal names, in words, for the draft strip; null when it named none (the refusal is not about the draft). */
export function draftRefusalWords(
  attempt: GateAttempt,
  headingOf: (sectionId: string) => string,
): string | null {
  if (attempt.state !== "refused" || attempt.refusal.outcome !== "blocked") return null;
  const issues = draftIssuesFrom(
    attempt.refusal.blockers.map(({ field, code }) => ({ field, code })),
  );
  return issues.length === 0 ? null : describeIssues(issues, headingOf);
}
