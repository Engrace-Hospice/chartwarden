// M25 — the manual-match posting decision and the adjustment-override decision (§2.2 / §4.1 #6-#7). PURE.
// The services wrap these with persistence; every branch that is not an `apply`/`post` fails closed.
import type { PostAction, PostingOutcome } from "./types";

/** The line states a manual match may start from. `manual_matched` is the legacy bound-but-never-posted state. */
export type ManualMatchLineFacts = {
  readonly matchState: string;
  readonly matchStrategy: string | null;
  readonly claimId: string | null;
};

export type ManualMatchDecision =
  /** Already manually matched + posted to this very claim: replay returns the stored state, emits nothing. */
  | { readonly kind: "noop"; readonly matchState: string }
  | { readonly kind: "post"; readonly nextState: "posted" | "reversed" }
  | { readonly kind: "conflict"; readonly reason: string };

const TERMINAL_STATES: ReadonlySet<string> = new Set(["posted", "reversed"]);

/**
 * Decide a manual match. Only an `unmatched` line (or a legacy `manual_matched` line bound to the SAME claim)
 * proceeds; a replay of a completed manual match to the same claim is a no-op; anything else is a conflict.
 * A reversal outcome (CLP02=22) lands in `reversed`, every other outcome in `posted` (§7.2).
 */
export function decideManualMatch(
  line: ManualMatchLineFacts,
  proposedClaimId: string,
  outcome: PostingOutcome,
): ManualMatchDecision {
  const sameManualClaim = line.matchStrategy === "manual" && line.claimId === proposedClaimId;
  if (TERMINAL_STATES.has(line.matchState) && sameManualClaim) {
    return { kind: "noop", matchState: line.matchState };
  }
  if (
    line.matchState === "unmatched" ||
    (line.matchState === "manual_matched" && sameManualClaim)
  ) {
    return { kind: "post", nextState: outcome === "recouped" ? "reversed" : "posted" };
  }
  return { kind: "conflict", reason: "only an unmatched line can be manually matched" };
}

export type AdjustmentOverrideFacts = {
  readonly postAction: PostAction;
  readonly amount: number;
  readonly denialCaseId: string | null;
};

export type AdjustmentOverrideDecision =
  | { readonly kind: "noop" }
  | { readonly kind: "apply"; readonly effect: "write_off" | "ledger" | "denial" }
  | { readonly kind: "conflict"; readonly reason: string };

/**
 * Decide an adjustment override. Only a `flagged_review` adjustment (an OA/CR or otherwise unclassified CAS)
 * can be reclassified; re-asserting the current action is an idempotent no-op. `ledger` additionally needs a
 * resolvable patient (a claim-matched line) and a positive amount (the ledger's `pr_amount > 0` CHECK), so a
 * caller that cannot supply `patientId` gets a conflict rather than a ledger row with no owner.
 */
export function decideAdjustmentOverride(
  facts: AdjustmentOverrideFacts,
  newAction: "auto_posted" | "ledger_recorded" | "denial_seeded",
  patientId: string | null,
): AdjustmentOverrideDecision {
  if (facts.postAction === newAction) return { kind: "noop" };
  if (facts.postAction !== "flagged_review") {
    return { kind: "conflict", reason: "only a flagged adjustment can be overridden" };
  }
  if (newAction === "auto_posted") return { kind: "apply", effect: "write_off" };
  if (newAction === "denial_seeded") return { kind: "apply", effect: "denial" };
  if (!patientId) {
    return {
      kind: "conflict",
      reason:
        "the patient-responsibility ledger needs a claim-matched line with a resolvable patient",
    };
  }
  if (!(facts.amount > 0)) {
    return { kind: "conflict", reason: "only a positive adjustment can be recorded on the ledger" };
  }
  return { kind: "apply", effect: "ledger" };
}
