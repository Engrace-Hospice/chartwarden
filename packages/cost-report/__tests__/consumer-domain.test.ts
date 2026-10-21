import type { CostReportState, ValidationContext } from "@chartwarden/cost-report";
import {
  applyTransition,
  canTransition,
  runValidation,
  suggestRuleFromRejection,
} from "@chartwarden/cost-report";
// @chartwarden/cost-report — pure-domain contracts the M27 §4.10 outbox CONSUMERS compose on (the inbound half
// of the module: apps/backend/src/modules/27-cost-report/consumers). These assert the EXACT pure-domain
// invariants the three consumer handlers depend on, so the handlers' fail-closed branches are grounded in
// tested domain behavior:
//
//  • handleProviderEntityOffboarded uses `canTransition(state, "offboard")` to decide WHICH still-open cost
//    reports to close — so the offboard-eligible state set must be exactly {draft, populating,
//    ready_for_review} (§2.2 / spec D3 line: only those → terminal `closed`), and `applyTransition` lands on
//    `closed` for them and throws for everything else.
//  • handleDenialOpened auto-suggests via `suggestRuleFromRejection`; that draft must be a non-`active`
//    `draft_suggestion` so a future `runValidation` never auto-executes (and never auto-BLOCKS) on it — the
//    "uncovered until platform-team curation" invariant (D20).
//
// PURE DOMAIN only — no DB, no Fastify, no network; no PHI (D18). Money is integer cents.
import { describe, expect, it } from "vitest";

const ALL_STATES: readonly CostReportState[] = [
  "draft",
  "populating",
  "validating",
  "ready_for_review",
  "approved_for_submit",
  "submitted",
  "accepted",
  "rejected",
  "reopened",
  "closed",
];

// The spec §2.2 / D3 close-on-offboard edge set: only these three states transition to terminal `closed`.
const OFFBOARD_ELIGIBLE: ReadonlySet<CostReportState> = new Set<CostReportState>([
  "draft",
  "populating",
  "ready_for_review",
]);

describe("offboard close-path — handleProviderEntityOffboarded's canTransition guard", () => {
  it("is offboard-eligible for exactly {draft, populating, ready_for_review}", () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, "offboard")).toBe(OFFBOARD_ELIGIBLE.has(state));
    }
  });

  it("an eligible state offboards to terminal `closed`", () => {
    for (const state of OFFBOARD_ELIGIBLE) {
      expect(applyTransition(state, "offboard")).toBe("closed");
    }
  });

  it("an ineligible state (e.g. submitted / accepted) is SKIPPED, not closed — the M34 gate's cases", () => {
    // The handler relies on canTransition===false here so these reports are never auto-closed; an
    // applyTransition attempt would (correctly) throw rather than silently coerce to `closed`.
    for (const state of ALL_STATES) {
      if (OFFBOARD_ELIGIBLE.has(state)) continue;
      expect(canTransition(state, "offboard")).toBe(false);
      expect(() => applyTransition(state, "offboard")).toThrow(/INVALID_TRANSITION/);
    }
  });
});

describe("auto-rule-suggestion — handleDenialOpened's draft-suggestion contract (D20)", () => {
  it("a suggested draft rule is non-`active`, so runValidation never executes it", () => {
    const draft = suggestRuleFromRejection("MAC-REJ-7788");
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("draft_suggestion");

    // A non-active rule is filtered out of the run entirely (zero results, never a fail/block) regardless
    // of context — the "uncovered until curated" invariant the denial handler relies on.
    const summary = runValidation([draft!], {} as unknown as ValidationContext);
    expect(summary.results).toHaveLength(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.blockingRulesFailing).toBe(0);
  });

  it("is deterministic + idempotent on the rejection code (same suggestion identity for equivalent codes)", () => {
    const a = suggestRuleFromRejection("MAC-REJ-7788");
    const b = suggestRuleFromRejection("  mac rej 7788  ");
    expect(a!.ruleCode).toBe(b!.ruleCode);
    expect(a!.ruleCode).toBe("mac.rejection.mac_rej_7788");
  });

  it("yields no suggestion for a blank/whitespace code (handler no-ops, never fabricates a rule)", () => {
    expect(suggestRuleFromRejection("")).toBeNull();
    expect(suggestRuleFromRejection("   \t  ")).toBeNull();
  });
});
