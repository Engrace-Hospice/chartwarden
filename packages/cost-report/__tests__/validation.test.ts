import {
  DEFAULT_VALIDATION_RULES,
  NGS_J6_MAC_SCOPE,
  NGS_J6_RULES,
  type RuleCategory,
  type ValidationContext,
  runValidation,
  suggestRuleFromRejection,
} from "@wardenx/cost-report";
// @wardenx/cost-report — M27 pre-submission validation framework pure-domain unit tests
// (§1.1, architecture §11.B, D9/D16/D20/D21).
//
// Covers: the 28 platform-default rules span all 16 §2.1 categories; `runValidation` over a fully-passing
// context yields `failedCount === 0`; a `regulatoryRequired` failure is BLOCKING (contributes to
// `blockingRulesFailing`); cap-category rules SKIP with `reason: 'seam_not_bound'` when the cap seam is
// unbound; the D20 `suggestRuleFromRejection` stub returns a `draft_suggestion` RuleDef for a known code
// and `null` for an unknown (blank) one; and the NGS-J6 additive profile rules carry the NGS-J6 MAC scope.
// PURE DOMAIN only — no DB, no Fastify, no network. Money is integer cents; no PHI (D18).
import { describe, expect, it } from "vitest";

const ALL_CATEGORIES: readonly RuleCategory[] = [
  "demographics_ownership",
  "statistical_data",
  "trial_balance",
  "reclassifications",
  "adjustments",
  "cost_allocation",
  "apportionment_programs",
  "balance_sheet",
  "cap",
  "bad_debt",
  "cross_worksheet",
  "mac_specific",
  "supporting_docs",
  "filing_deadline",
];

/**
 * A fully-passing `ValidationContext`: every applicable default rule either passes or (for the
 * seam-/bad-debt-gated rules) skips. No rule fails. Cap + bad-debt + claim-settlement seams are left
 * unbound so those rules defer.
 */
function passingContext(): ValidationContext {
  return {
    fiscalYearInt: 2026,
    macJurisdiction: "NGS-J6",
    badDebtClaimed: false,
    wageSource: "manual",
    demographics: {
      ccnPresent: true,
      fiscalYearEndConfigured: true,
      relatedPartyDisclosed: true,
    },
    trialBalance: {
      present: true,
      totalDebitsCents: 1_000_000,
      totalCreditsCents: 1_000_000,
    },
    mapping: { orphanAccountCount: 0, mappedAccountCount: 42 },
    statistics: {
      serviceCensusPatientDays: 365,
      billedCensusPatientDays: null,
      totalPatientDays: 365,
      s3GrandTotalPatientDays: 365,
      hasNegativeCensusValue: false,
    },
    worksheets: {
      presentCodes: ["A", "B", "B-1", "C", "F"],
      aGrandTotalCostsCents: 5_000_000,
      bTotalAllocatedCents: 5_000_000,
      bTiesToWorksheetA: true,
      reclassificationsNetCents: 0,
      adjustmentsUnsupportedCount: 0,
      statisticalBasisPresent: true,
      cTiesToWorksheetB: true,
      balanceSheetBalances: true,
    },
    cap: null,
    badDebt: { entries: [] },
    supportingDocs: { s2AttachmentsPresent: true },
    deadline: {
      pastDeadline: false,
      pastDeadlineOverrideGranted: false,
      daysToDeadline: 60,
      windowOpen: true,
    },
    seams: {
      capProviderBound: false,
      patientDaysProviderBound: false,
      claimSettlementProviderBound: false,
      drugCostBillingReaderBound: false,
    },
  };
}

describe("DEFAULT_VALIDATION_RULES — the 25-rule platform floor", () => {
  it("has exactly 25 rules", () => {
    expect(DEFAULT_VALIDATION_RULES).toHaveLength(25);
  });

  it("spans all 14 §2.1 rule categories (hospice form has no ancillary RCC or settlement worksheet)", () => {
    const present = new Set(DEFAULT_VALIDATION_RULES.map((r) => r.category));
    expect(present.size).toBe(14);
    expect([...present].sort()).toEqual([...ALL_CATEGORIES].sort());
  });

  it("has unique rule codes", () => {
    const codes = DEFAULT_VALIDATION_RULES.map((r) => r.ruleCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("runValidation — roll-up over a context", () => {
  it("a fully-passing context produces failedCount 0 and no blocking failures", () => {
    const summary = runValidation(DEFAULT_VALIDATION_RULES, passingContext());
    expect(summary.failedCount).toBe(0);
    expect(summary.blockingRulesFailing).toBe(0);
    // Every applied rule landed in exactly one bucket.
    const total =
      summary.passedCount + summary.failedCount + summary.warningCount + summary.skippedCount;
    expect(total).toBe(summary.results.length);
    expect(summary.passedCount).toBeGreaterThan(0);
  });

  it("a regulatory_required failure is BLOCKING (appears in blockingRulesFailing)", () => {
    const ctx = passingContext();
    // `tb.no_orphan_accounts` is regulatoryRequired and reads `mapping.orphanAccountCount` directly
    // (no seam) — orphan accounts force a regulatory FAIL.
    const failing: ValidationContext = {
      ...ctx,
      mapping: { ...ctx.mapping, orphanAccountCount: 3 },
    };
    const summary = runValidation(DEFAULT_VALIDATION_RULES, failing);

    expect(summary.failedCount).toBeGreaterThanOrEqual(1);
    expect(summary.blockingRulesFailing).toBe(1);

    const orphanRule = summary.results.find((r) => r.ruleCode === "tb.no_orphan_accounts");
    expect(orphanRule).toBeDefined();
    expect(orphanRule!.regulatoryRequired).toBe(true);
    expect(orphanRule!.result.outcome).toBe("fail");
  });

  it("an overridden regulatory failure leaves the blocking set, but still counts as failed", () => {
    const ctx = passingContext();
    const failing: ValidationContext = {
      ...ctx,
      mapping: { ...ctx.mapping, orphanAccountCount: 3 },
    };
    const summary = runValidation(
      DEFAULT_VALIDATION_RULES,
      failing,
      new Set(["tb.no_orphan_accounts"]),
    );
    expect(summary.failedCount).toBeGreaterThanOrEqual(1);
    expect(summary.overriddenCount).toBe(1);
    expect(summary.blockingRulesFailing).toBe(0);
  });

  it("cap-category rules SKIP with reason seam_not_bound when the cap seam is unbound", () => {
    // passingContext() leaves cap === null and capProviderBound === false.
    const summary = runValidation(DEFAULT_VALIDATION_RULES, passingContext());
    const capResults = summary.results.filter((r) => r.category === "cap");
    expect(capResults.length).toBe(3);
    for (const r of capResults) {
      expect(r.result.outcome).toBe("skip");
      expect(r.result.details.reason).toBe("seam_not_bound");
    }
  });
});

describe("suggestRuleFromRejection — D20 draft-suggestion stub", () => {
  it("returns a draft_suggestion, platform-owned RuleDef for a known (non-blank) rejection code", () => {
    const draft = suggestRuleFromRejection("REJ-123");
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("draft_suggestion");
    expect(draft!.category).toBe("mac_specific");
    expect(draft!.regulatoryRequired).toBe(false);
    expect(draft!.macJurisdictionScope).toBe("all");
    expect(draft!.ruleCode).toBe("mac.rejection.rej_123");
    // platform-owned: a RuleDef carries no tenant/organization binding.
    expect("organizationId" in draft!).toBe(false);
    // the suggested predicate is INERT until curated — it skips, never asserts.
    expect(draft!.evaluate(passingContext()).outcome).toBe("skip");
  });

  it("is deterministic — same rejection code yields the same suggestion code", () => {
    expect(suggestRuleFromRejection("REJ-123")!.ruleCode).toBe(
      suggestRuleFromRejection(" rej 123 ")!.ruleCode,
    );
  });

  it("returns null for an unknown (blank/whitespace) rejection code", () => {
    expect(suggestRuleFromRejection("")).toBeNull();
    expect(suggestRuleFromRejection("   ")).toBeNull();
  });
});

describe("NGS-J6 additive MAC profile", () => {
  it("scopes every NGS-J6 rule to the NGS-J6 jurisdiction", () => {
    expect(NGS_J6_MAC_SCOPE).toBe("NGS-J6");
    expect(NGS_J6_RULES.length).toBeGreaterThan(0);
    for (const r of NGS_J6_RULES) {
      expect(r.macJurisdictionScope).toBe("NGS-J6");
    }
  });

  it("the engine applies NGS-J6 rules to an NGS-J6 report but not to another MAC", () => {
    const ngsCtx = passingContext(); // macJurisdiction === "NGS-J6"
    const ngsSummary = runValidation(NGS_J6_RULES, ngsCtx);
    expect(ngsSummary.results.length).toBe(NGS_J6_RULES.length);

    const otherMac: ValidationContext = { ...ngsCtx, macJurisdiction: "CGS" };
    const otherSummary = runValidation(NGS_J6_RULES, otherMac);
    expect(otherSummary.results.length).toBe(0);
  });
});
