// M25 — appeal-case state machine (§2.2). PURE. Forward-only; once `closed` the row is frozen (the DB
// also enforces this via the closed-row immutability trigger in migration 0084). `withdrawn` is reachable
// from any non-terminal state. `decided` requires a decision_outcome (enforced by a DB CHECK + here).
import type { AppealDecisionOutcome, AppealState } from "./types";

export const APPEAL_TRANSITIONS: Readonly<Record<AppealState, readonly AppealState[]>> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["under_review", "withdrawn"],
  under_review: ["decided", "withdrawn"],
  decided: ["closed"],
  withdrawn: [],
  closed: [],
};

export function canTransitionAppeal(from: AppealState, to: AppealState): boolean {
  return APPEAL_TRANSITIONS[from].includes(to);
}

export function isAppealTerminal(state: AppealState): boolean {
  return state === "closed" || state === "withdrawn";
}

/** A decision must carry an outcome (mirrors the appeal_case_decided_has_outcome DB CHECK). */
export function decisionRequiresOutcome(
  to: AppealState,
  outcome: AppealDecisionOutcome | undefined,
): boolean {
  return to !== "decided" || outcome !== undefined;
}

/**
 * Whether an unfavorable/partial decision should spawn a next-tier appeal in `draft` (§2.4). Favorable
 * decisions resolve the underlying denial; unfavorable decisions cascade to the next tier when one exists.
 */
export function shouldSpawnNextTier(outcome: AppealDecisionOutcome): boolean {
  return outcome === "unfavorable";
}
