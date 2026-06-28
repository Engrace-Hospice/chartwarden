// @wardenx/billing — M23 §4.5 / §11.A the 19 platform-default validation rules pure-domain unit tests.
// For EACH rule: a passing `ValidationContext` (predicate holds) and a failing one (predicate fails), with
// the rule object's published METADATA asserted (severity + regulatoryRequired + overrideRoleRequired) so
// the §2.3 blocking-failure roll-up and the §4.5 worklist grouping stay grounded. Plus the cross-cutting
// scenarios the task calls out: the D5 regulatory-floor rules, the D9 EVV three-resolution gate, the D8
// cap-rule deny-stub degrade, and the D15 medicare-primary scope.
//
// PURE DOMAIN only — each rule.check(ctx, params) is a synchronous pure predicate; tests inject plain data.
// No DB, no Fastify, no clock; no PHI (D13). Money is integer cents.
import { describe, expect, it } from "vitest";
import type { Rule, RuleResult, ValidationContext } from "@wardenx/billing";
import {
  aggregateCapProjection,
  bereavementDischargeLegitimacy,
  ctiSignedPerPeriod,
  duplicateBillingCheck,
  electionPeriodActive,
  eligibilityCheckFreshness30d,
  evvBracketCoherence,
  f2fAttestedForRecert,
  hippsCodingCorrect,
  icd10Sequencing,
  ipuCapProjection,
  levelOfCareCoherence,
  modifierCodesValid,
  noeTimeliness5d,
  patientEligibilityPartAActive,
  physicianCredentialsActive,
  placeOfServiceConsistency,
  siaCalculationCorrect,
  tobAndDatesConsistency,
} from "@wardenx/billing";
import { passingContext } from "./_fixtures";

/** Evaluate a rule against `ctx` using its declared default parameters (the engine merge with no overlay). */
function run(rule: Rule, ctx: ValidationContext): RuleResult {
  return rule.check(ctx, rule.defaultParameters ?? {});
}
function isSkip(r: RuleResult): boolean {
  return r.annotations?.skipReason !== undefined;
}

// ── per-rule published metadata (severity / regulatory / override role) ──────────────────────────────────

interface ExpectedMeta {
  readonly key: string;
  readonly severity: "error" | "warn" | "info";
  readonly regulatoryRequired: boolean;
  readonly overrideRoleRequired: string | undefined;
}

const RULE_META: ReadonlyArray<readonly [Rule, ExpectedMeta]> = [
  [patientEligibilityPartAActive, { key: "patient_eligibility_part_a_active", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [eligibilityCheckFreshness30d, { key: "eligibility_check_freshness_30d", severity: "warn", regulatoryRequired: false, overrideRoleRequired: "billing_manager" }],
  [electionPeriodActive, { key: "election_period_active", severity: "error", regulatoryRequired: true, overrideRoleRequired: "medical_director" }],
  [ctiSignedPerPeriod, { key: "cti_signed_per_period", severity: "error", regulatoryRequired: true, overrideRoleRequired: "medical_director" }],
  [f2fAttestedForRecert, { key: "f2f_attested_for_recert", severity: "error", regulatoryRequired: true, overrideRoleRequired: "medical_director" }],
  [levelOfCareCoherence, { key: "level_of_care_coherence", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [hippsCodingCorrect, { key: "hipps_coding_correct", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [siaCalculationCorrect, { key: "sia_calculation_correct", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [icd10Sequencing, { key: "icd10_sequencing", severity: "error", regulatoryRequired: true, overrideRoleRequired: "medical_director" }],
  [physicianCredentialsActive, { key: "physician_credentials_active", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [noeTimeliness5d, { key: "noe_timeliness_5d", severity: "error", regulatoryRequired: true, overrideRoleRequired: "compliance_officer" }],
  [tobAndDatesConsistency, { key: "tob_and_dates_consistency", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [duplicateBillingCheck, { key: "duplicate_billing_check", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [placeOfServiceConsistency, { key: "place_of_service_consistency", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [aggregateCapProjection, { key: "aggregate_cap_projection", severity: "error", regulatoryRequired: true, overrideRoleRequired: "compliance_officer" }],
  [ipuCapProjection, { key: "ipu_cap_projection", severity: "error", regulatoryRequired: true, overrideRoleRequired: "compliance_officer" }],
  [bereavementDischargeLegitimacy, { key: "bereavement_discharge_legitimacy", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [modifierCodesValid, { key: "modifier_codes_valid", severity: "error", regulatoryRequired: true, overrideRoleRequired: "billing_manager" }],
  [evvBracketCoherence, { key: "evv_bracket_coherence", severity: "error", regulatoryRequired: true, overrideRoleRequired: "compliance_officer" }],
];

describe("rule metadata (§4.5)", () => {
  for (const [rule, meta] of RULE_META) {
    it(`${meta.key} carries the declared severity / regulatory / override metadata`, () => {
      expect(rule.key).toBe(meta.key);
      expect(rule.severity).toBe(meta.severity);
      expect(rule.regulatoryRequired).toBe(meta.regulatoryRequired);
      expect(rule.overrideRoleRequired).toBe(meta.overrideRoleRequired);
      expect(rule.version).toBeGreaterThanOrEqual(1);
      expect(typeof rule.title).toBe("string");
      expect(rule.title.length).toBeGreaterThan(0);
    });
  }

  it("exactly one default rule is NON-regulatory (eligibility_check_freshness_30d, a warn)", () => {
    const nonReg = RULE_META.filter(([, m]) => !m.regulatoryRequired).map(([, m]) => m.key);
    expect(nonReg).toEqual(["eligibility_check_freshness_30d"]);
  });
});

// ── per-rule pass + fail ─────────────────────────────────────────────────────────────────────────────

describe("patient_eligibility_part_a_active", () => {
  it("passes when eligibility is active_part_a", () => {
    const r = run(patientEligibilityPartAActive, passingContext());
    expect(r.passed).toBe(true);
    expect(isSkip(r)).toBe(false);
  });
  it("BLOCKS (fail, error) when Part A is inactive", () => {
    const ctx = passingContext();
    const r = run(patientEligibilityPartAActive, {
      ...ctx,
      eligibility: { ...ctx.eligibility!, outcome: "inactive_part_a" },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("SKIPs (deny-stub) when the eligibility seam is unbound", () => {
    const ctx = passingContext();
    const r = run(patientEligibilityPartAActive, {
      ...ctx,
      eligibility: null,
      seams: { ...ctx.seams, eligibilityBound: false },
    });
    expect(isSkip(r)).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBe("seam_not_bound");
  });
  it("fails CLOSED (error) on an indeterminate check", () => {
    const ctx = passingContext();
    const r = run(patientEligibilityPartAActive, {
      ...ctx,
      eligibility: { ...ctx.eligibility!, outcome: "indeterminate" },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
});

describe("eligibility_check_freshness_30d (non-regulatory, warn)", () => {
  it("passes when the check is within 30 days", () => {
    expect(run(eligibilityCheckFreshness30d, passingContext()).passed).toBe(true);
  });
  it("warns (fail at warn severity) when the check is stale", () => {
    const ctx = passingContext();
    const r = run(eligibilityCheckFreshness30d, {
      ...ctx,
      eligibility: { ...ctx.eligibility!, ageDays: 45 },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warn");
  });
});

describe("election_period_active (D5 regulatory)", () => {
  it("passes when an active period covers every service date", () => {
    expect(run(electionPeriodActive, passingContext()).passed).toBe(true);
  });
  it("fails when no election period exists", () => {
    const r = run(electionPeriodActive, { ...passingContext(), electionPeriods: [] });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when a service date falls after the revocation date", () => {
    const ctx = passingContext();
    const r = run(electionPeriodActive, {
      ...ctx,
      electionPeriods: [
        { sequence: 1, effectiveFrom: "2026-02-01", effectiveTo: null, revoked: true, revocationDate: "2026-03-10" },
      ],
    });
    expect(r.passed).toBe(false); // the 2026-03-15 line + 2026-03-31 service_to are past revocation
  });
});

describe("cti_signed_per_period (D5 regulatory)", () => {
  it("passes with a signed CTI for every overlapping period", () => {
    expect(run(ctiSignedPerPeriod, passingContext()).passed).toBe(true);
  });
  it("fails when the CTI is unsigned", () => {
    const ctx = passingContext();
    const r = run(ctiSignedPerPeriod, {
      ...ctx,
      certifications: [{ ...ctx.certifications[0]!, ctiSigned: false }],
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when the attending co-sign is required but missing", () => {
    const ctx = passingContext();
    const r = run(ctiSignedPerPeriod, {
      ...ctx,
      certifications: [{ ...ctx.certifications[0]!, attendingCosignRequired: true, attendingCosigned: false }],
    });
    expect(r.passed).toBe(false);
  });
});

describe("f2f_attested_for_recert (D5 regulatory)", () => {
  it("passes when no recertification period (seq >= 3) is in range", () => {
    expect(run(f2fAttestedForRecert, passingContext()).passed).toBe(true);
  });
  it("fails when a recert period lacks a face-to-face attestation", () => {
    const ctx = passingContext();
    const r = run(f2fAttestedForRecert, {
      ...ctx,
      electionPeriods: [
        { sequence: 3, effectiveFrom: "2026-02-01", effectiveTo: null, revoked: false, revocationDate: null },
      ],
      faceToFace: [],
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("passes when the recert period HAS an attested face-to-face", () => {
    const ctx = passingContext();
    const r = run(f2fAttestedForRecert, {
      ...ctx,
      electionPeriods: [
        { sequence: 3, effectiveFrom: "2026-02-01", effectiveTo: null, revoked: false, revocationDate: null },
      ],
      faceToFace: [{ electionPeriodSequence: 3, attested: true, encounterDate: "2026-01-20" }],
    });
    expect(r.passed).toBe(true);
  });
});

describe("level_of_care_coherence", () => {
  it("passes when the line LOC/revenue cohere with the LOC period", () => {
    expect(run(levelOfCareCoherence, passingContext()).passed).toBe(true);
  });
  it("fails on a revenue-code mismatch", () => {
    const ctx = passingContext();
    const r = run(levelOfCareCoherence, {
      ...ctx,
      lines: [{ ...ctx.lines[0]!, revenueCode: "9999" }],
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when CHC has fewer than 8 documented hours", () => {
    const ctx = passingContext();
    const r = run(levelOfCareCoherence, {
      ...ctx,
      lines: [{ ...ctx.lines[0]!, levelOfCare: "continuous_home_care", revenueCode: "0652" }],
      levelOfCarePeriods: [
        { levelOfCare: "continuous_home_care", from: "2026-02-01", to: "2026-12-31", chcDocumentedHours: 4, gipAdmissionCriteriaDocumented: null },
      ],
    });
    expect(r.passed).toBe(false);
  });
});

describe("hipps_coding_correct", () => {
  it("passes on a structurally coherent HIPPS snapshot", () => {
    expect(run(hippsCodingCorrect, passingContext()).passed).toBe(true);
  });
  it("SKIPs (not_applicable) when no HIPPS derivation is present", () => {
    const r = run(hippsCodingCorrect, { ...passingContext(), hipps: null });
    expect(isSkip(r)).toBe(true);
    expect(r.annotations?.skipReason).toBe("not_applicable");
  });
  it("fails when the HIPPS code is the wrong length", () => {
    const ctx = passingContext();
    const r = run(hippsCodingCorrect, { ...ctx, hipps: { ...ctx.hipps!, hippsCode: "AB" } });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when an RHC segment carries no day-bucket", () => {
    const ctx = passingContext();
    const r = run(hippsCodingCorrect, {
      ...ctx,
      hipps: { ...ctx.hipps!, segments: [{ ...ctx.hipps!.segments[0]!, rhcDayBucket: "n/a" }] },
    });
    expect(r.passed).toBe(false);
  });
});

describe("sia_calculation_correct", () => {
  it("SKIPs (not_applicable) when no SIA is present", () => {
    const r = run(siaCalculationCorrect, passingContext());
    expect(isSkip(r)).toBe(true);
  });
  it("passes when the SIA is backed by signed RN/MSW visits and not double-counted", () => {
    const ctx = passingContext();
    const r = run(siaCalculationCorrect, {
      ...ctx,
      sia: { present: true, qualifyingVisitCount: 2, amountCents: 5_000, doubleCounted: false },
      signedEncounters: [
        { encounterId: "e1", serviceDate: "2026-03-29", discipline: "RN", signed: true, cosignRequired: false, cosigned: false, durationMinutes: 60 },
        { encounterId: "e2", serviceDate: "2026-03-30", discipline: "MSW", signed: true, cosignRequired: false, cosigned: false, durationMinutes: 45 },
      ],
    });
    expect(r.passed).toBe(true);
  });
  it("fails when claimed visits exceed the backing signed RN/MSW visits", () => {
    const ctx = passingContext();
    const r = run(siaCalculationCorrect, {
      ...ctx,
      sia: { present: true, qualifyingVisitCount: 3, amountCents: 5_000, doubleCounted: false },
      signedEncounters: [],
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when the SIA is double-counted", () => {
    const ctx = passingContext();
    const r = run(siaCalculationCorrect, {
      ...ctx,
      sia: { present: true, qualifyingVisitCount: 1, amountCents: 5_000, doubleCounted: true },
      signedEncounters: [
        { encounterId: "e1", serviceDate: "2026-03-29", discipline: "RN", signed: true, cosignRequired: false, cosigned: false, durationMinutes: 60 },
      ],
    });
    expect(r.passed).toBe(false);
  });
});

describe("icd10_sequencing", () => {
  it("passes with terminal-first, billable codes", () => {
    expect(run(icd10Sequencing, passingContext()).passed).toBe(true);
  });
  it("SKIPs when terminology (M38) is unbound", () => {
    const ctx = passingContext();
    const r = run(icd10Sequencing, { ...ctx, seams: { ...ctx.seams, terminologyBound: false } });
    expect(isSkip(r)).toBe(true);
    expect(r.annotations?.skipReason).toBe("seam_not_bound");
  });
  it("fails when the principal diagnosis is not terminal", () => {
    const ctx = passingContext();
    const r = run(icd10Sequencing, {
      ...ctx,
      claim: { ...ctx.claim, icd10Sequence: [{ position: 1, code: "G30.9", relationship: "related" }] },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when a code is not billable per M38", () => {
    const ctx = passingContext();
    const r = run(icd10Sequencing, {
      ...ctx,
      terminology: { ...ctx.terminology, icd10Billable: { "G30.9": false } },
    });
    expect(r.passed).toBe(false);
  });
});

describe("physician_credentials_active", () => {
  it("passes when the hospice physician is active + licensed", () => {
    expect(run(physicianCredentialsActive, passingContext()).passed).toBe(true);
  });
  it("SKIPs when the M40 resolver is unbound", () => {
    const ctx = passingContext();
    const r = run(physicianCredentialsActive, { ...ctx, seams: { ...ctx.seams, mdmResolverBound: false } });
    expect(isSkip(r)).toBe(true);
  });
  it("fails when the hospice physician NPI is inactive in NPPES", () => {
    const ctx = passingContext();
    const r = run(physicianCredentialsActive, {
      ...ctx,
      mdm: { ...ctx.mdm, hospicePhysician: { npi: "1234567893", status: "inactive", licenseUnexpiredOnServiceDates: true } },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
});

describe("noe_timeliness_5d", () => {
  it("passes when the NOE is ack-accepted", () => {
    expect(run(noeTimeliness5d, passingContext()).passed).toBe(true);
  });
  it("fails when no NOE exists", () => {
    const r = run(noeTimeliness5d, { ...passingContext(), noe: null });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("BLOCKS (error) when the 5-day window is breached and the NOE is not accepted", () => {
    const ctx = passingContext();
    const r = run(noeTimeliness5d, {
      ...ctx,
      noe: { state: "submitted", admissionDay: 7, windowBreached: true },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("WARNS near the deadline (day 3, within the window)", () => {
    const ctx = passingContext();
    const r = run(noeTimeliness5d, {
      ...ctx,
      noe: { state: "submitted", admissionDay: 3, windowBreached: false },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warn");
  });
});

describe("tob_and_dates_consistency (D4 / D14)", () => {
  it("passes for a coherent TOB 812 first interim", () => {
    expect(run(tobAndDatesConsistency, passingContext()).passed).toBe(true);
  });
  it("fails an 811 with no discharge date", () => {
    const ctx = passingContext();
    const r = run(tobAndDatesConsistency, { ...ctx, claim: { ...ctx.claim, tob: "811", dischargeDate: null } });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails an 813 continuing interim without a prior 812/813", () => {
    const ctx = passingContext();
    const r = run(tobAndDatesConsistency, { ...ctx, claim: { ...ctx.claim, tob: "813", priorClaimTob: null } });
    expect(r.passed).toBe(false);
  });
  it("fails an 817 replacement with no predecessor reference", () => {
    const ctx = passingContext();
    const r = run(tobAndDatesConsistency, { ...ctx, claim: { ...ctx.claim, tob: "817", replacesClaimId: null } });
    expect(r.passed).toBe(false);
  });
});

describe("duplicate_billing_check", () => {
  it("passes when there is no overlap with the prior claim", () => {
    expect(run(duplicateBillingCheck, passingContext()).passed).toBe(true);
  });
  it("fails when service dates overlap the immediately-prior claim", () => {
    const ctx = passingContext();
    const r = run(duplicateBillingCheck, {
      ...ctx,
      claim: { ...ctx.claim, priorClaimServiceTo: "2026-03-15" }, // serviceFrom 2026-03-01 <= prior through
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("a 817/818 replacement/void legitimately re-covers a prior range (exempt)", () => {
    const ctx = passingContext();
    const r = run(duplicateBillingCheck, {
      ...ctx,
      claim: { ...ctx.claim, tob: "818", replacesClaimId: "claim-0", priorClaimServiceTo: "2026-03-15" },
    });
    expect(r.passed).toBe(true);
  });
});

describe("place_of_service_consistency", () => {
  it("passes when each Q-code matches the documented place of service", () => {
    expect(run(placeOfServiceConsistency, passingContext()).passed).toBe(true);
  });
  it("SKIPs when the M40 resolver is unbound", () => {
    const ctx = passingContext();
    const r = run(placeOfServiceConsistency, { ...ctx, seams: { ...ctx.seams, mdmResolverBound: false } });
    expect(isSkip(r)).toBe(true);
  });
  it("fails when a line Q-code disagrees with the documented place", () => {
    const ctx = passingContext();
    const r = run(placeOfServiceConsistency, {
      ...ctx,
      lines: [{ ...ctx.lines[0]!, qCode: "Q5004" }], // snf vs documented home
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
});

describe("bereavement_discharge_legitimacy", () => {
  it("passes a non-discharge claim with no bereavement charge", () => {
    expect(run(bereavementDischargeLegitimacy, passingContext()).passed).toBe(true);
  });
  it("fails a discharge TOB (811) missing reason/date", () => {
    const ctx = passingContext();
    const r = run(bereavementDischargeLegitimacy, {
      ...ctx,
      claim: { ...ctx.claim, tob: "811", dischargeDate: null, dischargeReason: null },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("fails when a bereavement line (0942) carries a billable charge", () => {
    const ctx = passingContext();
    const r = run(bereavementDischargeLegitimacy, {
      ...ctx,
      lines: [{ ...ctx.lines[0]!, revenueCode: "0942", lineChargeCents: 5_000 }],
    });
    expect(r.passed).toBe(false);
  });
});

describe("modifier_codes_valid", () => {
  it("passes when all modifiers are in the CMS value set (or none present)", () => {
    expect(run(modifierCodesValid, passingContext()).passed).toBe(true);
  });
  it("SKIPs when terminology (M38) is unbound", () => {
    const ctx = passingContext();
    const r = run(modifierCodesValid, { ...ctx, seams: { ...ctx.seams, terminologyBound: false } });
    expect(isSkip(r)).toBe(true);
  });
  it("fails on an invalid modifier code", () => {
    const ctx = passingContext();
    const r = run(modifierCodesValid, {
      ...ctx,
      lines: [{ ...ctx.lines[0]!, modifiers: ["ZZ"] }],
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
});

// ── D9 EVV three-resolution gate ─────────────────────────────────────────────────────────────────────

describe("evv_bracket_coherence (D9 / ADR-0008 — only unresolved_missing blocks)", () => {
  function withBracket(state: ValidationContext["evvBrackets"][number]["bracketState"]) {
    const ctx = passingContext();
    return { ...ctx, evvBrackets: [{ encounterId: "enc-1", bracketState: state }] };
  }

  it("compliant → pass", () => {
    expect(run(evvBracketCoherence, withBracket("compliant")).passed).toBe(true);
  });
  it("not_required → pass", () => {
    expect(run(evvBracketCoherence, withBracket("not_required")).passed).toBe(true);
  });
  it("documented_missing → pass (allows submission with the in-encounter evv_missing_reason attestation)", () => {
    // NOTE: the pure rule treats documented_missing as a PASS; the §11.A `evv_missing_reason` attestation
    // itself is an M18/M8 in-encounter fact, NOT surfaced on this pure-domain result. See returned flags.
    const r = run(evvBracketCoherence, withBracket("documented_missing"));
    expect(r.passed).toBe(true);
    expect(isSkip(r)).toBe(false);
  });
  it("unresolved_missing → BLOCKS (fail, error)", () => {
    const r = run(evvBracketCoherence, withBracket("unresolved_missing"));
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.annotations?.observed?.unresolvedCount).toBe(1);
  });
});

// ── D8 cap deny-stub degrade ─────────────────────────────────────────────────────────────────────────

describe("aggregate_cap_projection (D8 deny-stub degrade)", () => {
  it("SKIPs (seam_not_bound, non-blocking) while the M26 cap provider is a deny-stub", () => {
    // IMPLEMENTATION NOTE / FLAG: the spec narrative says this rule "degrades to `warn` with a
    // `cap_projection_unavailable` annotation"; the implementation instead emits a non-blocking SKIP with
    // skipReason `seam_not_bound` (the M27 deny-stub convention). Both are non-blocking; the skip carries
    // no `cap_projection_unavailable` annotation. Asserting ACTUAL behavior.
    const r = run(aggregateCapProjection, passingContext()); // capProjection null + capProjectionBound false
    expect(isSkip(r)).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBe("seam_not_bound");
    expect(r.message).toMatch(/unavailable/i);
  });
  it("tightens to a hard ERROR block once bound + over the patient cap", () => {
    const ctx = passingContext();
    const r = run(aggregateCapProjection, {
      ...ctx,
      seams: { ...ctx.seams, capProjectionBound: true },
      capProjection: { patientWithinCap: false, orgPctOfCap: 80, ipuWithinCap: true },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("warns when the agency-wide projection is within 5% of the cap", () => {
    const ctx = passingContext();
    const r = run(aggregateCapProjection, {
      ...ctx,
      seams: { ...ctx.seams, capProjectionBound: true },
      capProjection: { patientWithinCap: true, orgPctOfCap: 97, ipuWithinCap: true },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warn");
  });
  it("passes when bound + comfortably within the cap", () => {
    const ctx = passingContext();
    const r = run(aggregateCapProjection, {
      ...ctx,
      seams: { ...ctx.seams, capProjectionBound: true },
      capProjection: { patientWithinCap: true, orgPctOfCap: 50, ipuWithinCap: true },
    });
    expect(r.passed).toBe(true);
  });
});

describe("ipu_cap_projection (D8 deny-stub degrade)", () => {
  it("SKIPs (seam_not_bound) while M26 is a deny-stub", () => {
    const r = run(ipuCapProjection, passingContext());
    expect(isSkip(r)).toBe(true);
    expect(r.annotations?.skipReason).toBe("seam_not_bound");
  });
  it("blocks (error) once bound + over the inpatient cap", () => {
    const ctx = passingContext();
    const r = run(ipuCapProjection, {
      ...ctx,
      seams: { ...ctx.seams, capProjectionBound: true },
      capProjection: { patientWithinCap: true, orgPctOfCap: 50, ipuWithinCap: false },
    });
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("error");
  });
  it("passes once bound + within the inpatient cap", () => {
    const ctx = passingContext();
    const r = run(ipuCapProjection, {
      ...ctx,
      seams: { ...ctx.seams, capProjectionBound: true },
      capProjection: { patientWithinCap: true, orgPctOfCap: 50, ipuWithinCap: true },
    });
    expect(r.passed).toBe(true);
  });
});

// ── D5 regulatory floor + D15 medicare-primary scope ─────────────────────────────────────────────────

describe("D5 regulatory floor — every CFR-mandated rule is regulatoryRequired with an elevated override", () => {
  const regulatory = RULE_META.filter(([, m]) => m.regulatoryRequired);
  it("18 of the 19 default rules are regulatoryRequired", () => {
    expect(regulatory).toHaveLength(18);
  });
  for (const [rule, meta] of regulatory) {
    it(`${meta.key} requires an elevated override approver (cannot be skip-and-submit'd)`, () => {
      expect(rule.regulatoryRequired).toBe(true);
      expect(rule.overrideRoleRequired).toBeDefined();
      expect(["billing_manager", "compliance_officer", "medical_director", "org_admin"]).toContain(
        rule.overrideRoleRequired,
      );
    });
  }
});

describe("D15 medicare-primary scope", () => {
  // FLAG: there is NO `medicare-primary` validation rule among the 19 platform defaults. Per spec D15 the
  // Medicare-primary-payer-only scope is enforced at CLAIM ASSEMBLY (a structured rejection routing
  // non-Medicare-FFS claims to M24), and the §11.A `Medicaid (when applicable)` row is a M24 hand-off
  // contract, NOT a M23-internal rule. The medicare-primary flag is exposed via the M24 coordination DTO
  // (`MedicareSecondaryContextDto.medicarePrimary`), not via a runnable rule predicate.
  it("no default rule is named/keyed as medicare-primary (D15 is an assembly-time gate, not a rule)", () => {
    const keys = RULE_META.map(([, m]) => m.key);
    expect(keys.some((k) => /medicare.?primary|primary.?payer|medicaid/.test(k))).toBe(false);
  });
});
