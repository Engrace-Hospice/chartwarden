import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDICAID_RULES,
  createDefaultMedicaidRegistry,
  medicaidEvvBracketCoherence,
  medicarePrimaryRequiredForDual,
  runMedicaidRules,
} from "../src/rules";
import type { MedicaidRule, MedicaidValidationContext } from "../src/rules";

function baseCtx(): MedicaidValidationContext {
  return {
    orgId: "org1",
    asOfDate: "2026-01-01",
    serviceState: "OR",
    claim: {
      claimId: "c1",
      providerEntityId: "pe1",
      patientId: "p1",
      serviceState: "OR",
      kind: "combined_hospice_rb",
      tob: "811",
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-31",
      replacesClaimId: null,
      medicareClaimId: "mc1",
      rbArrangementId: "rb1",
      isDualEligible: true,
    },
    lines: [
      {
        claimLineId: "l1",
        serviceDate: "2026-01-01",
        levelOfCare: "NF_RB",
        revenueCode: "0658",
        qCode: "Q5003",
        modifiers: [],
        rateAtAssemblyCents: 20000,
        isRb: true,
        backingEncounterIds: ["e1"],
      },
    ],
    eligibility: { outcome: "active", checkedAt: "2026-01-01T00:00:00.000Z", asOfDate: "2026-01-01", ageDays: 5, mcoId: null },
    recipientIdFormatValid: true,
    mcoRouting: { eligibilityIsMcoAssignment: false, resolvedChannel: null, hasActiveCredentialForChannel: false },
    nfResidentDays: [{ serviceDate: "2026-01-01", isNfResident: true, locOfDay: "RHC" }],
    rbArrangement: { arrangementId: "rb1", state: "ACTIVE", effectiveFrom: "2025-12-01", effectiveTo: null },
    rbDays: [{ serviceDate: "2026-01-01", locOfDay: "RHC", status: "billable", arrangementEffectiveOnDate: true }],
    rateLookups: [{ serviceDate: "2026-01-01", loc: "NF_RB", rateFound: true, rateCents: 20000 }],
    medicareSecondary: { medicareClaimState: "ack_accepted", eobContextPresent: true },
    evvBrackets: [{ encounterId: "e1", bracketState: "compliant" }],
    capProjection: { patientWithinCap: true },
    modifiersSatisfied: true,
    documentationSatisfied: true,
    adapterMetadata: { acceptsDocumentedMissingEvv: false, combinesHospiceAndRb: true, supportedTobs: ["811"] },
    seams: {
      eligibilityBound: true,
      rbBound: true,
      rateScheduleBound: true,
      medicareClaimBound: true,
      capProjectionBound: true,
      mdmBound: true,
      adapterBound: true,
    },
  };
}

describe("default Medicaid rule set", () => {
  it("ships 13 default rules, 12 regulatory-required (freshness is the lone non-regulatory warn)", () => {
    expect(DEFAULT_MEDICAID_RULES).toHaveLength(13);
    expect(DEFAULT_MEDICAID_RULES.filter((r) => r.regulatoryRequired)).toHaveLength(12);
    const nonReg = DEFAULT_MEDICAID_RULES.filter((r) => !r.regulatoryRequired);
    expect(nonReg.map((r) => r.key)).toEqual(["medicaid_eligibility_freshness_30d"]);
  });

  it("a clean claim passes every rule with zero blocking failures", () => {
    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, baseCtx());
    expect(summary.blockingFailures).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.warningCount).toBe(0);
    expect(summary.results).toHaveLength(13);
  });

  it("the registry freezes and rejects post-freeze registration + duplicate keys", () => {
    const reg = createDefaultMedicaidRegistry();
    expect(reg.all()).toHaveLength(13);
    expect(() => reg.registerRule(DEFAULT_MEDICAID_RULES[0]!)).toThrow(/Duplicate/);
    reg.freeze();
    expect(reg.isFrozen()).toBe(true);
  });
});

describe("individual rule failures", () => {
  it("inactive eligibility blocks", () => {
    const ctx = baseCtx();
    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, {
      ...ctx,
      eligibility: { ...ctx.eligibility!, outcome: "inactive" },
    });
    expect(summary.blockingFailures).toBeGreaterThanOrEqual(1);
  });

  it("NF resident without an arrangement blocks", () => {
    const ctx = baseCtx();
    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, {
      ...ctx,
      claim: { ...ctx.claim, rbArrangementId: null },
    });
    expect(summary.blockingFailures).toBeGreaterThanOrEqual(1);
  });

  it("dual-eligible without an accepted Medicare-primary blocks", () => {
    const ctx = baseCtx();
    const r = medicarePrimaryRequiredForDual.check(
      { ...ctx, medicareSecondary: { medicareClaimState: "submitted", eobContextPresent: false } },
      {},
    );
    expect(r.passed).toBe(false);
  });

  it("EVV documented_missing blocks unless the adapter accepts it (Oregon: false)", () => {
    const ctx = baseCtx();
    const blocked = medicaidEvvBracketCoherence.check(
      { ...ctx, evvBrackets: [{ encounterId: "e1", bracketState: "documented_missing" }] },
      {},
    );
    expect(blocked.passed).toBe(false);
    const allowed = medicaidEvvBracketCoherence.check(
      {
        ...ctx,
        adapterMetadata: { ...ctx.adapterMetadata, acceptsDocumentedMissingEvv: true },
        evvBrackets: [{ encounterId: "e1", bracketState: "documented_missing" }],
      },
      {},
    );
    expect(allowed.passed).toBe(true);
  });

  it("an unbound seam SKIPs (non-blocking) rather than failing", () => {
    const ctx = baseCtx();
    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, {
      ...ctx,
      eligibility: null,
      seams: { ...ctx.seams, eligibilityBound: false },
    });
    expect(summary.skippedCount).toBeGreaterThanOrEqual(1);
    expect(summary.blockingFailures).toBe(0);
  });

  it("an overridden blocking failure no longer counts as blocking", () => {
    const ctx = baseCtx();
    const broken = { ...ctx, eligibility: { ...ctx.eligibility!, outcome: "inactive" as const } };
    const withOverride = runMedicaidRules(
      DEFAULT_MEDICAID_RULES,
      broken,
      {},
      new Set(["medicaid_eligibility_active"]),
    );
    expect(withOverride.overriddenCount).toBeGreaterThanOrEqual(1);
    expect(withOverride.blockingFailures).toBe(0);
  });
});

describe("applicableStates gating", () => {
  it("a state-scoped rule SKIPs not_applicable on a non-matching claim state", () => {
    const waOnly: MedicaidRule = {
      key: "wa_only_rule",
      version: 1,
      category: "eligibility",
      title: "WA only",
      description: "x",
      severity: "error",
      regulatoryRequired: true,
      applicableStates: ["WA"],
      check: () => ({ ruleKey: "wa_only_rule", severity: "error", passed: false, message: "should not run" }),
    };
    const summary = runMedicaidRules([waOnly], baseCtx());
    expect(summary.skippedCount).toBe(1);
    expect(summary.blockingFailures).toBe(0);
    expect(summary.results[0]!.annotations?.skipReason).toBe("not_applicable");
  });
});
