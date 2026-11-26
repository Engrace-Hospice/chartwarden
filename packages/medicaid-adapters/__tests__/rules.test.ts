import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDICAID_RULES,
  createDefaultMedicaidRegistry,
  medicaidEvvBracketCoherence,
  medicaidMedicareClaimLinkageSupported,
  medicaidPayerResponsibilityResolved,
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
      admissionId: "adm1",
      serviceState: "OR",
      kind: "combined_hospice_rb",
      tob: "811",
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-31",
      replacesClaimId: null,
      medicareClaimId: null,
      primaryPayerCoverageId: null,
      rbArrangementId: "rb1",
      hasConcurrentMedicareAndMedicaidCoverage: false,
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
    eligibility: {
      outcome: "active",
      checkedAt: "2026-01-01T00:00:00.000Z",
      asOfDate: "2026-01-01",
      ageDays: 5,
      mcoId: null,
    },
    recipientIdFormatValid: true,
    mcoRouting: {
      eligibilityIsMcoAssignment: false,
      resolvedChannel: null,
      hasActiveCredentialForChannel: false,
    },
    nfResidentDays: [{ serviceDate: "2026-01-01", isNfResident: true, locOfDay: "RHC" }],
    rbArrangement: {
      arrangementId: "rb1",
      state: "ACTIVE",
      effectiveFrom: "2025-12-01",
      effectiveTo: null,
    },
    rbDays: [
      {
        serviceDate: "2026-01-01",
        locOfDay: "RHC",
        status: "billable",
        arrangementEffectiveOnDate: true,
      },
    ],
    rbClaimSnapshotVerified: true,
    hospiceClaimSnapshotVerified: true,
    hospicePricingSnapshotVerified: true,
    hospiceInstitutionalFormatQualified: true,
    rateLookups: [{ serviceDate: "2026-01-01", loc: "NF_RB", rateFound: true, rateCents: 20000 }],
    payerResponsibility: { status: "permitted", reasonCode: null },
    evvBrackets: [{ encounterId: "e1", bracketState: "compliant" }],
    capProjection: { patientWithinCap: true },
    modifiersSatisfied: true,
    documentationSatisfied: true,
    adapterMetadata: {
      acceptsDocumentedMissingEvv: false,
      combinesHospiceAndRb: true,
      supportedTobs: ["811"],
    },
    seams: {
      eligibilityBound: true,
      rbBound: true,
      rateScheduleBound: true,
      capProjectionBound: true,
      mdmBound: true,
      adapterBound: true,
    },
  };
}

describe("default Medicaid rule set", () => {
  it("distinguishes regulatory rules from non-regulatory platform safety gates", () => {
    expect(DEFAULT_MEDICAID_RULES).toHaveLength(19);
    expect(DEFAULT_MEDICAID_RULES.filter((r) => r.regulatoryRequired)).toHaveLength(11);
    expect(
      DEFAULT_MEDICAID_RULES.filter((r) => r.platformRequired)
        .map((r) => r.key)
        .sort(),
    ).toEqual([
      "medicaid_hospice_claim_snapshot_verified",
      "medicaid_hospice_institutional_format_qualified",
      "medicaid_medicare_linkage_supported",
      "medicaid_payer_rate_policy_snapshot_verified",
      "medicaid_payer_responsibility_resolved",
      "medicaid_rb_claim_snapshot_verified",
      "medicare_primary_required_for_dual",
    ]);
    const freshnessRule = DEFAULT_MEDICAID_RULES.find(
      (r) => r.key === "medicaid_eligibility_freshness_30d",
    );
    expect(freshnessRule?.regulatoryRequired).toBe(false);
    expect(freshnessRule?.platformRequired).toBeUndefined();
  });

  it("keeps platform safety gates blocking even if a stale override key is supplied", () => {
    const rule = DEFAULT_MEDICAID_RULES.find(
      (candidate) => candidate.key === "medicaid_payer_responsibility_resolved",
    );
    expect(rule).toBeDefined();
    const unresolved = {
      ...baseCtx(),
      payerResponsibility: { status: "unresolved" as const, reasonCode: "coverage_unknown" },
    };
    const summary = runMedicaidRules([rule!], unresolved, {}, new Set([rule!.key]));
    expect(summary.blockingFailures).toBe(1);
    expect(summary.overriddenCount).toBe(0);
  });

  it("keeps a local hospice coding profile out of READY even when pricing snapshots pass", () => {
    const localContext: MedicaidValidationContext = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, kind: "hospice_only" },
      lines: baseCtx().lines.map((line) => ({
        ...line,
        isRb: false,
        levelOfCare: "RHC",
        revenueCode: "0651",
        qCode: "Q5001",
      })),
      hospicePricingSnapshotVerified: true,
      hospiceInstitutionalFormatQualified: false,
    };
    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, localContext);
    const format = summary.results.find(
      (result) => result.ruleKey === "medicaid_hospice_institutional_format_qualified",
    );
    const pricing = summary.results.find(
      (result) => result.ruleKey === "medicaid_payer_rate_policy_snapshot_verified",
    );
    expect(pricing?.passed).toBe(true);
    expect(format?.passed).toBe(false);
    expect(summary.blockingFailures).toBe(1);
    expect(
      runMedicaidRules(
        DEFAULT_MEDICAID_RULES,
        localContext,
        {},
        new Set(["medicaid_hospice_institutional_format_qualified"]),
      ).blockingFailures,
    ).toBeGreaterThan(0);
  });

  it("blocks background readiness for an R&B claim without a verified current snapshot", () => {
    const rule = DEFAULT_MEDICAID_RULES.find(
      (candidate) => candidate.key === "medicaid_rb_claim_snapshot_verified",
    );
    expect(rule).toBeDefined();
    const result = runMedicaidRules(
      [rule!],
      { ...baseCtx(), rbClaimSnapshotVerified: false },
      {},
      new Set([rule!.key]),
    );
    expect(result.results[0]).toMatchObject({ passed: false, severity: "error" });
    expect(result.blockingFailures).toBe(1);
    expect(result.overriddenCount).toBe(0);
  });

  it("blocks hospice claim readiness without current M6 line evidence, even if overridden", () => {
    const rule = DEFAULT_MEDICAID_RULES.find(
      (candidate) => candidate.key === "medicaid_hospice_claim_snapshot_verified",
    );
    expect(rule).toBeDefined();
    const context = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, kind: "hospice_only" as const },
      lines: [
        {
          ...baseCtx().lines[0]!,
          isRb: false,
          levelOfCare: "RHC" as const,
          revenueCode: "0651",
        },
      ],
      hospiceClaimSnapshotVerified: false,
    };
    const result = runMedicaidRules([rule!], context, {}, new Set([rule!.key]));
    expect(result.results[0]).toMatchObject({ passed: false, severity: "error" });
    expect(result.blockingFailures).toBe(1);
    expect(result.overriddenCount).toBe(0);
  });

  it("does not require a hospice LOC snapshot for R&B-only claims", () => {
    const rule = DEFAULT_MEDICAID_RULES.find(
      (candidate) => candidate.key === "medicaid_hospice_claim_snapshot_verified",
    );
    expect(rule).toBeDefined();
    const context = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, kind: "rb_only" as const },
      hospiceClaimSnapshotVerified: false,
    };
    expect(rule!.check(context, {}).passed).toBe(true);
  });

  it("blocks hospice claim readiness without a payer-rate snapshot and cannot be overridden", () => {
    const rule = DEFAULT_MEDICAID_RULES.find(
      (candidate) => candidate.key === "medicaid_payer_rate_policy_snapshot_verified",
    );
    expect(rule).toBeDefined();
    expect(rule?.platformRequired).toBe(true);
    const context = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, kind: "hospice_only" as const },
      lines: [
        {
          ...baseCtx().lines[0]!,
          isRb: false,
          levelOfCare: "RHC" as const,
          revenueCode: "0651",
        },
      ],
      hospicePricingSnapshotVerified: false,
    };
    const result = runMedicaidRules([rule!], context, {}, new Set([rule!.key]));
    expect(result.results[0]).toMatchObject({ passed: false, severity: "error" });
    expect(result.blockingFailures).toBe(1);
    expect(result.overriddenCount).toBe(0);

    const rbOnly = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, kind: "rb_only" as const },
      lines: [{ ...baseCtx().lines[0]!, isRb: true }],
      hospicePricingSnapshotVerified: false,
    };
    expect(rule?.check(rbOnly, {}).passed).toBe(true);
  });

  it("does not require an R&B snapshot for a hospice-only claim", () => {
    const rule = DEFAULT_MEDICAID_RULES.find(
      (candidate) => candidate.key === "medicaid_rb_claim_snapshot_verified",
    );
    expect(rule).toBeDefined();
    const context = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, kind: "hospice_only" as const },
      lines: baseCtx().lines.map((line) => ({ ...line, isRb: false })),
      rbClaimSnapshotVerified: false,
    };
    expect(rule!.check(context, {}).passed).toBe(true);
  });

  it("does not let a legacy Medicare claim reference advance through background validation", () => {
    const context = {
      ...baseCtx(),
      claim: { ...baseCtx().claim, medicareClaimId: "synthetic-unverified-medicare-claim" },
    };
    const summary = runMedicaidRules(
      [medicaidMedicareClaimLinkageSupported],
      context,
      {},
      new Set([medicaidMedicareClaimLinkageSupported.key]),
    );
    expect(summary.results[0]).toMatchObject({
      ruleKey: "medicaid_medicare_linkage_supported",
      passed: false,
    });
    expect(summary.blockingFailures).toBe(1);
    expect(summary.overriddenCount).toBe(0);
  });

  it("a clean claim passes every rule with zero blocking failures", () => {
    const summary = runMedicaidRules(DEFAULT_MEDICAID_RULES, baseCtx());
    expect(summary.blockingFailures).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.warningCount).toBe(0);
    expect(summary.results).toHaveLength(19);
  });

  it("the registry freezes and rejects post-freeze registration + duplicate keys", () => {
    const reg = createDefaultMedicaidRegistry();
    expect(reg.all()).toHaveLength(19);
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

  it("unresolved and blocked payer responsibility are mandatory failures, not overrides or skips", () => {
    const ctx = baseCtx();
    for (const payerResponsibility of [
      { status: "unresolved", reasonCode: "coverage_changed" },
      { status: "blocked", reasonCode: "third_party_liability_policy_unconfirmed" },
    ] as const) {
      const result = medicaidPayerResponsibilityResolved.check({ ...ctx, payerResponsibility }, {});
      expect(result.passed).toBe(false);
      expect(result.annotations?.skipReason).toBeUndefined();
      expect(medicaidPayerResponsibilityResolved.overrideRoleRequired).toBeUndefined();
    }
  });

  it("secondary Medicaid policy remains blocked regardless of Medicare state or stale overrides", () => {
    const ctx = baseCtx();
    const result = medicarePrimaryRequiredForDual.check(
      {
        ...ctx,
        claim: { ...ctx.claim, hasConcurrentMedicareAndMedicaidCoverage: true },
      },
      {},
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain("state-specific secondary Medicaid");
    const summary = runMedicaidRules(
      [medicarePrimaryRequiredForDual],
      {
        ...ctx,
        claim: { ...ctx.claim, hasConcurrentMedicareAndMedicaidCoverage: true },
      },
      {},
      new Set([medicarePrimaryRequiredForDual.key]),
    );
    expect(summary.blockingFailures).toBe(1);
    expect(summary.overriddenCount).toBe(0);
  });

  it("a Medicare denial does not override a blocked payer-responsibility decision", () => {
    const ctx = baseCtx();
    const dual = {
      ...ctx,
      claim: {
        ...ctx.claim,
        medicareClaimId: "mc1",
        primaryPayerCoverageId: "medicare-coverage-1",
        hasConcurrentMedicareAndMedicaidCoverage: true,
      },
      payerResponsibility: { status: "blocked" as const, reasonCode: "state_policy_unconfirmed" },
    } satisfies MedicaidValidationContext;
    expect(medicarePrimaryRequiredForDual.check(dual, {}).passed).toBe(false);
    expect(medicaidPayerResponsibilityResolved.check(dual, {}).passed).toBe(false);
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
      check: () => ({
        ruleKey: "wa_only_rule",
        severity: "error",
        passed: false,
        message: "should not run",
      }),
    };
    const summary = runMedicaidRules([waOnly], baseCtx());
    expect(summary.skippedCount).toBe(1);
    expect(summary.blockingFailures).toBe(0);
    expect(summary.results[0]!.annotations?.skipReason).toBe("not_applicable");
  });
});
