// apps/backend/__tests__/bereavement-risk.test.ts — M16-T04 (§4.3.3 scorer, §4.3.4 extraction, D3, D8,
// D17, §7.3 worked example, §7.13 redaction, §7.17 partial data).
//
// The whole D3 chain, exercised without a DB: the pure derivation and rubric directly, then the seam-fed
// extractor against registered fake M15 / M9 seams. The point of most of these cases is one distinction —
// `false` (assessed, negative) versus `unknown` (unknowable) — because that is the difference between an
// honest tier and one a permission boundary or a seam outage silently lowered.
import {
  BEREAVEMENT_RULE_SCORE_SCALE,
  type BereavementRiskEvidence,
  type BereavementRosterEvidence,
  MSW_FACTOR_ALIASES,
  PPS_EXPECTED_DECLINE_DELTA,
  PPS_IMMINENT_DEATH_CEILING,
  SOCIAL_SUPPORT_ROSTER_FLOOR,
  SUD_REDACTION_CATEGORY,
  computeBereavementRiskScore,
  deriveRiskFactors,
  evaluateBereavementLayer2Eligibility,
  mergeAugmentation,
  normalizeMswFactor,
  ruleScoreToWeighted,
  suddenUnexpectedDeathFromPps,
  weightedScoreToRuleScore,
} from "@wardenx/bereavement";
import type { MswRiskFactor, ScaleSeriesPoint } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { BereavementStateError } from "../src/modules/16-bereavement/lifecycle/index";
import {
  type RiskExtractionInput,
  type RiskScoreRequest,
  computeDeterministicRisk,
  extractRiskInputs,
  gatherRiskEvidence,
  requestAugmentedRisk,
  riskScoreComputedPayload,
  scoreBereavementRisk,
} from "../src/modules/16-bereavement/risk/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PLAN = "22222222-2222-2222-2222-222222222222";
const CONTACT = "33333333-3333-3333-3333-333333333333";
const PE = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PATIENT = "66666666-6666-6666-6666-666666666666";
const DEATH_AT = "2026-06-10T04:00:00.000Z";

function msw(factor: string, severity: MswRiskFactor["severity"] = "moderate"): MswRiskFactor {
  return {
    planId: "plan-m15",
    admissionId: ADMISSION,
    assessmentId: "assess-1",
    factor,
    severity,
    icd10: null,
    capturedAt: "2026-06-01T00:00:00.000Z",
  };
}

function pps(capturedAt: string, score: number | null): ScaleSeriesPoint {
  return {
    assessmentId: `a-${capturedAt}`,
    capturedAt,
    score,
    scoreInterpretation: null,
    significantChange: false,
  };
}

const SEEDED_ROSTER: BereavementRosterEvidence = {
  isPrimaryCaregiver: true,
  enrolledSurvivorCount: 4,
};
const UNSEEDED_ROSTER: BereavementRosterEvidence = {
  isPrimaryCaregiver: null,
  enrolledSurvivorCount: null,
};

function evidence(over: Partial<BereavementRiskEvidence> = {}): BereavementRiskEvidence {
  return {
    mswAssessed: true,
    mswFactors: [],
    ppsPoints: [],
    roster: SEEDED_ROSTER,
    sudDisclosureAllowed: true,
    ...over,
  };
}

function request(over: Partial<RiskScoreRequest> = {}): RiskScoreRequest {
  return {
    planId: PLAN,
    contactId: CONTACT,
    providerEntityId: PE,
    locationId: null,
    assessedByUserId: null,
    assessedAt: "2026-06-12T00:00:00.000Z",
    amendmentKind: "initial",
    amendedFromScoreId: null,
    ...over,
  };
}

const EXTRACTION: RiskExtractionInput = {
  organizationId: ORG,
  admissionId: ADMISSION,
  patientId: PATIENT,
  deathAt: DEATH_AT,
  roster: SEEDED_ROSTER,
  sudDisclosureAllowed: true,
};

// ── The M15 vocabulary mapping ───────────────────────────────────────────────────────────────────────

describe("MSW vocabulary → the 8 D17 rubric slots", () => {
  it("normalizes the spellings MSW templates actually produce", () => {
    expect(normalizeMswFactor("Prior Unresolved Loss")).toBe("prior_unresolved_loss");
    expect(normalizeMswFactor("  social-isolation  ")).toBe("social_isolation");
    expect(normalizeMswFactor("Substance Use Disorder (active)")).toBe(
      "substance_use_disorder_active",
    );
  });

  it("maps §7.3's `sole_caregiver_isolation` onto socialIsolation", () => {
    expect(MSW_FACTOR_ALIASES["sole_caregiver_isolation"]).toBe("socialIsolation");
  });

  it("surfaces an MSW finding with no rubric slot instead of weighting or dropping it", () => {
    // §7.3 names `age_over_80`, which D17's locked 8-factor vector has no slot for.
    const derived = deriveRiskFactors(evidence({ mswFactors: [msw("age_over_80")] }));
    expect(derived.unmappedMswFactors).toEqual(["age_over_80"]);
    expect(Object.values(derived.factors)).not.toContain("unknown");
  });
});

// ── Rule 1: MSW knowability ──────────────────────────────────────────────────────────────────────────

describe("rule 1 — an unlisted MSW domain is `false` only when an assessment exists", () => {
  it("§7.3: with MSW findings present, the unlisted psychosocial domains are documented negatives", () => {
    const derived = deriveRiskFactors(
      evidence({ mswFactors: [msw("prior_unresolved_loss"), msw("mental_health_history")] }),
    );
    expect(derived.factors.priorUnresolvedLoss).toBe(true);
    expect(derived.factors.preExistingMentalHealth).toBe(true);
    expect(derived.factors.ambivalentRelationship).toBe(false);
    expect(derived.factors.financialStrain).toBe(false);
  });

  it("§7.17: with no MSW assessment, every MSW-sourced domain is `unknown`, never `false`", () => {
    const derived = deriveRiskFactors(
      evidence({ mswAssessed: false, mswFactors: [], ppsPoints: null, roster: SEEDED_ROSTER }),
    );
    expect(derived.factors.ambivalentRelationship).toBe("unknown");
    expect(derived.factors.priorUnresolvedLoss).toBe("unknown");
    expect(derived.factors.preExistingMentalHealth).toBe("unknown");
    expect(derived.factors.financialStrain).toBe("unknown");
    expect(derived.factors.activeSubstanceUse).toBe("unknown");
    // The roster still knows these two — they are M16's own rows, not M15's.
    expect(derived.factors.primaryCaregiverRole).toBe(true);
    expect(derived.factors.socialIsolation).toBe(false);
  });
});

// ── Rule 2: redaction is not absence (§7.13) ─────────────────────────────────────────────────────────

describe("rule 2 — a 42 CFR Part 2 redaction resolves `unknown` and is named", () => {
  it("without a disclosure, activeSubstanceUse is unknowable and `sud` is recorded", () => {
    const derived = deriveRiskFactors(evidence({ sudDisclosureAllowed: false }));
    expect(derived.factors.activeSubstanceUse).toBe("unknown");
    expect(derived.redactedCategories).toEqual([SUD_REDACTION_CATEGORY]);
  });

  it("scoring the redacted slot `unknown` never understates risk the way D17's rejected `false` would", () => {
    // The two candidate treatments of a hidden factor, on the SAME vector. `unknown` shrinks the divisor;
    // `false` (rejected alternative (a)) keeps it and dilutes the positive share.
    const redacted = deriveRiskFactors(
      evidence({ mswFactors: [msw("ambivalent_relationship")], sudDisclosureAllowed: false }),
    );
    const asUnknown = computeBereavementRiskScore(redacted.factors);
    const asFalse = computeBereavementRiskScore({ ...redacted.factors, activeSubstanceUse: false });
    expect(asUnknown.weightedScore).toBeGreaterThanOrEqual(asFalse.weightedScore);
  });

  it("a redaction is visible in the completeness band rather than hidden in the score", () => {
    const open = computeBereavementRiskScore(
      deriveRiskFactors(evidence({ mswFactors: [msw("ambivalent_relationship")] })).factors,
    );
    const redacted = computeBereavementRiskScore(
      deriveRiskFactors(
        evidence({ mswFactors: [msw("ambivalent_relationship")], sudDisclosureAllowed: false }),
      ).factors,
    );
    expect(open.dataCompleteness).toBe("complete");
    expect(redacted.dataCompleteness).toBe("partial");
    expect(redacted.unknownFactorCount).toBe(1);
  });

  it("with a disclosure and no SUD finding, the slot is a documented negative and nothing is redacted", () => {
    const derived = deriveRiskFactors(evidence({ mswFactors: [msw("social_isolation")] }));
    expect(derived.factors.activeSubstanceUse).toBe(false);
    expect(derived.redactedCategories).toEqual([]);
  });
});

// ── Rule 3: the M9 PPS trajectory ────────────────────────────────────────────────────────────────────

describe("rule 3 — `suddenUnexpectedDeath` needs a slope, not a reading", () => {
  it("§7.17: a single admission PPS is not a trajectory", () => {
    expect(suddenUnexpectedDeathFromPps([pps("2026-06-06T00:00:00.000Z", 50)])).toBe("unknown");
  });

  it("a null series (M9 unreadable) is `unknown`", () => {
    expect(suddenUnexpectedDeathFromPps(null)).toBe("unknown");
  });

  it("scores with a null value are not comparable and do not count toward the two-point floor", () => {
    expect(
      suddenUnexpectedDeathFromPps([
        pps("2026-01-01T00:00:00.000Z", 60),
        pps("2026-06-01T00:00:00.000Z", null),
      ]),
    ).toBe("unknown");
  });

  it("§7.3: a long documented decline makes the death expected", () => {
    expect(
      suddenUnexpectedDeathFromPps([
        pps("2025-12-01T00:00:00.000Z", 70),
        pps("2026-03-01T00:00:00.000Z", 50),
        pps("2026-06-01T00:00:00.000Z", 70 - PPS_EXPECTED_DECLINE_DELTA),
      ]),
    ).toBe(false);
  });

  it("a final reading in the imminent band is expected however short the stay", () => {
    expect(
      suddenUnexpectedDeathFromPps([
        pps("2026-06-01T00:00:00.000Z", PPS_IMMINENT_DEATH_CEILING + 5),
        pps("2026-06-08T00:00:00.000Z", PPS_IMMINENT_DEATH_CEILING),
      ]),
    ).toBe(false);
  });

  it("a stable high trajectory that ends in death is sudden", () => {
    expect(
      suddenUnexpectedDeathFromPps([
        pps("2026-05-01T00:00:00.000Z", 70),
        pps("2026-06-01T00:00:00.000Z", 60),
      ]),
    ).toBe(true);
  });

  it("orders by capturedAt, not by array position", () => {
    const outOfOrder = [pps("2026-06-01T00:00:00.000Z", 20), pps("2026-01-01T00:00:00.000Z", 70)];
    expect(suddenUnexpectedDeathFromPps(outOfOrder)).toBe(false);
  });

  it("an MSW who documented a traumatic death outranks whatever slope M9 drew", () => {
    const derived = deriveRiskFactors(
      evidence({
        mswFactors: [msw("traumatic_death")],
        ppsPoints: [pps("2026-05-01T00:00:00.000Z", 40), pps("2026-06-01T00:00:00.000Z", 20)],
      }),
    );
    expect(derived.factors.suddenUnexpectedDeath).toBe(true);
  });
});

// ── The roster proxies ───────────────────────────────────────────────────────────────────────────────

describe("roster-sourced slots", () => {
  it("§7.17: an enrolled roster at or above the support floor is documented support", () => {
    const derived = deriveRiskFactors(
      evidence({
        mswAssessed: false,
        roster: { isPrimaryCaregiver: false, enrolledSurvivorCount: SOCIAL_SUPPORT_ROSTER_FLOOR },
      }),
    );
    expect(derived.factors.socialIsolation).toBe(false);
    expect(derived.factors.primaryCaregiverRole).toBe(false);
  });

  it("a lone enrollee with no MSW reads as isolated", () => {
    const derived = deriveRiskFactors(
      evidence({
        mswAssessed: false,
        roster: { isPrimaryCaregiver: true, enrolledSurvivorCount: 1 },
      }),
    );
    expect(derived.factors.socialIsolation).toBe(true);
  });

  it("an unseeded roster is `unknown` on both slots, not `false`", () => {
    const derived = deriveRiskFactors(
      evidence({ mswAssessed: false, mswFactors: [], roster: UNSEEDED_ROSTER }),
    );
    expect(derived.factors.socialIsolation).toBe("unknown");
    expect(derived.factors.primaryCaregiverRole).toBe("unknown");
  });

  it("an MSW isolation finding outranks a large roster", () => {
    const derived = deriveRiskFactors(
      evidence({ mswFactors: [msw("social_isolation")], roster: SEEDED_ROSTER }),
    );
    expect(derived.factors.socialIsolation).toBe(true);
  });
});

// ── §7.3 / §7.17 end-to-end ──────────────────────────────────────────────────────────────────────────

describe("§7.3 — Mrs. Whitfield scores `high` on a complete vector", () => {
  const whitfield = evidence({
    mswFactors: [
      msw("sole_caregiver_isolation", "high"),
      msw("prior_unresolved_loss"),
      msw("mental_health_history"),
      msw("social_isolation"),
      msw("age_over_80"),
    ],
    // >180-day admission with a documented decline ⇒ the death was expected.
    ppsPoints: [pps("2025-11-01T00:00:00.000Z", 60), pps("2026-06-01T00:00:00.000Z", 20)],
    roster: { isPrimaryCaregiver: true, enrolledSurvivorCount: 4 },
  });

  it("derives the §7.3 vector: 4 positives, the rest documented negatives", () => {
    const { factors } = deriveRiskFactors(whitfield);
    expect(factors).toEqual({
      ambivalentRelationship: false,
      suddenUnexpectedDeath: false,
      priorUnresolvedLoss: true,
      preExistingMentalHealth: true,
      socialIsolation: true,
      financialStrain: false,
      primaryCaregiverRole: true,
      activeSubstanceUse: false,
    });
  });

  it("lands tier `high` with a complete vector and a HIGH confidence band", () => {
    const result = computeDeterministicRisk(whitfield, request());
    expect(result.draft.ruleTier).toBe("high");
    expect(result.draft.dataCompleteness).toBe("complete");
    expect(result.draft.confidenceBand).toBe("HIGH");
    expect(result.scored.weightedScore).toBeCloseTo(0.51, 5);
    expect(result.draft.ruleScore).toBe(51);
  });

  it("records the unmapped `age_over_80` finding in the vector without weighting it", () => {
    const result = computeDeterministicRisk(whitfield, request());
    expect(result.draft.riskFactorsJsonb.unmappedMswFactors).toEqual(["age_over_80"]);
  });
});

describe("§7.17 — W-M16-10 risk scoring with partial data", () => {
  const partial = evidence({
    mswAssessed: false,
    mswFactors: [],
    ppsPoints: [pps("2026-06-06T00:00:00.000Z", 50)],
    roster: { isPrimaryCaregiver: true, enrolledSurvivorCount: 2 },
  });

  it("resolves 2 known / 6 unknown and bands `minimal` / LOW", () => {
    const result = computeDeterministicRisk(partial, request());
    expect(result.scored.knownFactorCount).toBe(2);
    expect(result.draft.dataCompleteness).toBe("minimal");
    expect(result.draft.confidenceBand).toBe("LOW");
    expect(result.scored.advisoryOnly).toBe(true);
  });

  it("the score is computed over the knowable factors only, not over 8", () => {
    const result = computeDeterministicRisk(partial, request());
    // primaryCaregiverRole (0.10) positive of {primaryCaregiverRole 0.10, socialIsolation 0.13}.
    expect(result.scored.weightedScore).toBeCloseTo(0.1 / 0.23, 5);
  });

  it("the outbox payload carries the band M30's denominator filters on", () => {
    const result = computeDeterministicRisk(partial, request());
    const payload = riskScoreComputedPayload(result.draft, "score-1");
    expect(payload.dataCompleteness).toBe("minimal");
    expect(payload.confidenceBand).toBe("LOW");
    expect(payload.contactId).toBe(CONTACT);
    expect(payload.scoreKind).toBe("rule_deterministic");
  });

  it("a plan-level rollup omits the contact id rather than inventing one", () => {
    const result = computeDeterministicRisk(partial, request({ contactId: undefined }));
    expect(result.draft.bereavedContactId).toBeNull();
    expect(riskScoreComputedPayload(result.draft, "score-1").contactId).toBeUndefined();
  });
});

// ── The `rule_score` persistence scale ───────────────────────────────────────────────────────────────

describe("the integer `rule_score` column round-trips the 0..1 weighted score", () => {
  it("scales to hundredths", () => {
    expect(weightedScoreToRuleScore(0.51)).toBe(51);
    expect(weightedScoreToRuleScore(1)).toBe(BEREAVEMENT_RULE_SCORE_SCALE);
    expect(weightedScoreToRuleScore(0)).toBe(0);
  });

  it("reads back inside a hundredth", () => {
    for (const w of [0, 0.06, 0.25, 0.5, 0.51, 0.94, 1]) {
      expect(ruleScoreToWeighted(weightedScoreToRuleScore(w))).toBeCloseTo(w, 2);
    }
  });
});

// ── D8: the grief-screen promotion and the counselor override ────────────────────────────────────────

describe("D8 — a positive complicated-grief screen promotes, a negative one never demotes", () => {
  const moderate = evidence({
    mswFactors: [msw("prior_unresolved_loss"), msw("mental_health_history")],
    ppsPoints: [pps("2026-01-01T00:00:00.000Z", 60), pps("2026-06-01T00:00:00.000Z", 20)],
  });

  it("§7.7: a 31/52 PG-13 promotes the tier to `complicated` on the NEW row", () => {
    const result = computeDeterministicRisk(
      moderate,
      request({
        amendmentKind: "complicated_grief_promotion",
        amendedFromScoreId: "score-0",
        griefScreen: { pg13Score: 31, ipgrScore: null },
        priorTier: "high",
      }),
    );
    expect(result.draft.ruleTier).toBe("complicated");
    expect(result.draft.riskFactorsJsonb.pg13Score).toBe(31);
    expect(result.draft.riskFactorsJsonb.amendedFromScoreId).toBe("score-0");
  });

  it("a below-threshold screen leaves the deterministic tier alone", () => {
    const result = computeDeterministicRisk(
      moderate,
      request({ griefScreen: { pg13Score: 12, ipgrScore: null } }),
    );
    expect(result.draft.ruleTier).toBe(result.scored.tier);
    expect(result.draft.ruleTier).not.toBe("complicated");
  });

  it("the rubric's own tier is preserved in the vector when a screen promoted the row", () => {
    const result = computeDeterministicRisk(
      moderate,
      request({ griefScreen: { pg13Score: 31, ipgrScore: 40 } }),
    );
    expect(result.draft.riskFactorsJsonb.deterministicTier).toBe(result.scored.tier);
    expect(result.draft.riskFactorsJsonb.deterministicTier).not.toBe("complicated");
    expect(result.draft.riskFactorsJsonb.ipgrScore).toBe(40);
  });
});

describe("§7.3 — the counselor override is the one path off the rubric, and it must be documented", () => {
  const reason =
    "Rubric missed the survivor's disclosed suicidal ideation during the week-1 in-person visit.";

  it("lands the override tier when the reason clears the 40-character floor", () => {
    const result = computeDeterministicRisk(
      evidence(),
      request({
        amendmentKind: "counselor_override",
        amendmentReason: reason,
        overrideTier: "high",
        amendedFromScoreId: "score-0",
      }),
    );
    expect(result.draft.ruleTier).toBe("high");
    expect(result.draft.riskFactorsJsonb.amendmentReason).toBe(reason);
    expect(result.draft.riskFactorsJsonb.deterministicTier).toBe("low");
  });

  it("refuses a short reason with RISK_OVERRIDE_REASON_TOO_SHORT (422)", () => {
    let caught: unknown;
    try {
      computeDeterministicRisk(
        evidence(),
        request({
          amendmentKind: "counselor_override",
          amendmentReason: "too short",
          overrideTier: "high",
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BereavementStateError);
    expect((caught as BereavementStateError).code).toBe("RISK_OVERRIDE_REASON_TOO_SHORT");
    expect((caught as BereavementStateError).statusCode).toBe(422);
  });

  it("refuses an override that names no tier", () => {
    let caught: unknown;
    try {
      computeDeterministicRisk(
        evidence(),
        request({ amendmentKind: "counselor_override", amendmentReason: reason }),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as BereavementStateError).code).toBe("RISK_OVERRIDE_TIER_REQUIRED");
  });
});

// ── §2.6 side effects ────────────────────────────────────────────────────────────────────────────────

describe("§2.6 — every append audits and emits; only an escalation alerts", () => {
  const high = evidence({
    mswFactors: [
      msw("sole_caregiver_isolation"),
      msw("prior_unresolved_loss"),
      msw("mental_health_history"),
    ],
    ppsPoints: [pps("2026-01-01T00:00:00.000Z", 60), pps("2026-06-01T00:00:00.000Z", 20)],
  });

  it("the first score is a starting point, not an escalation", () => {
    const result = computeDeterministicRisk(high, request({ priorTier: null }));
    expect(result.effects).toEqual([
      { kind: "audit" },
      { kind: "outbox", event: "m16.bereavement.risk_score_computed" },
    ]);
  });

  it("a tier that rose since the prior row raises the §4.10 alert", () => {
    const result = computeDeterministicRisk(high, request({ priorTier: "low" }));
    expect(result.effects).toContainEqual({ kind: "alert", alert: "risk_tier_escalated" });
  });

  it("a tier that fell does not alert", () => {
    const result = computeDeterministicRisk(evidence(), request({ priorTier: "complicated" }));
    expect(result.effects.some((e) => e.kind === "alert")).toBe(false);
  });
});

// ── §4.3.4 extraction through the M1 seam registry ───────────────────────────────────────────────────

describe("§4.3.4 — evidence gathered through M15 + M9, fail-SOFT to `unknown`", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  function registerBoth(
    factors: readonly MswRiskFactor[],
    points: readonly ScaleSeriesPoint[],
  ): void {
    registerSeam("MswRiskFactorReader", {
      async riskFactorsForAdmission() {
        return factors;
      },
    });
    registerSeam("ScaleSeriesProvider", {
      async series(patientId, scaleType, from, to) {
        return { scaleType, patientId, from, to, points };
      },
      async delta(patientId, scaleType, window) {
        return { scaleType, patientId, window, latestScore: null, priorScore: null, delta: null };
      },
    });
  }

  it("reads both seams and derives the vector from what they returned", async () => {
    registerBoth(
      [msw("prior_unresolved_loss")],
      [pps("2026-01-01T00:00:00.000Z", 60), pps("2026-06-01T00:00:00.000Z", 20)],
    );
    const derived = await extractRiskInputs(EXTRACTION);
    expect(derived.factors.priorUnresolvedLoss).toBe(true);
    expect(derived.factors.suddenUnexpectedDeath).toBe(false);
    expect(derived.factors.ambivalentRelationship).toBe(false);
  });

  it("windows the PPS series back from the death instant, not from now", async () => {
    let seen: { from: string; to: string } | null = null;
    registerSeam("MswRiskFactorReader", {
      async riskFactorsForAdmission() {
        return [];
      },
    });
    registerSeam("ScaleSeriesProvider", {
      async series(patientId, scaleType, from, to) {
        seen = { from, to };
        return { scaleType, patientId, from, to, points: [] };
      },
      async delta(patientId, scaleType, window) {
        return { scaleType, patientId, window, latestScore: null, priorScore: null, delta: null };
      },
    });
    await gatherRiskEvidence(EXTRACTION);
    expect(seen).not.toBeNull();
    expect(seen!.to).toBe(DEATH_AT);
    expect(Date.parse(DEATH_AT) - Date.parse(seen!.from)).toBe(180 * 86_400_000);
  });

  it("an UNREGISTERED seam (the M1 deny-stub) degrades to `unknown` — it never throws and never scores `false`", async () => {
    // Nothing registered: both reads hit their fail-closed deny-stubs.
    const gathered = await gatherRiskEvidence(EXTRACTION);
    expect(gathered.mswReadable).toBe(false);
    expect(gathered.ppsReadable).toBe(false);
    expect(gathered.evidence.mswAssessed).toBe(false);
    expect(gathered.evidence.ppsPoints).toBeNull();

    const result = await scoreBereavementRisk(EXTRACTION, request());
    expect(result.draft.riskFactorsJsonb.factors.priorUnresolvedLoss).toBe("unknown");
    expect(result.draft.riskFactorsJsonb.factors.suddenUnexpectedDeath).toBe("unknown");
    expect(result.draft.confidenceBand).toBe("LOW");
    // The outage is on the record, so an `unknown` is not mistaken for an unasked question.
    expect(result.draft.riskFactorsJsonb.evidenceDegraded).toBe(true);
  });

  it("a zero-finding MSW answer is still `unknown`, because the seam returns positives only", async () => {
    registerBoth([], []);
    const gathered = await gatherRiskEvidence(EXTRACTION);
    expect(gathered.mswReadable).toBe(true);
    expect(gathered.evidence.mswAssessed).toBe(false);
    const derived = await extractRiskInputs(EXTRACTION);
    expect(derived.factors.ambivalentRelationship).toBe("unknown");
  });

  it("a readable pair is not flagged degraded", async () => {
    registerBoth([msw("financial_strain")], [pps("2026-06-01T00:00:00.000Z", 20)]);
    const result = await scoreBereavementRisk(EXTRACTION, request());
    expect(result.draft.riskFactorsJsonb.evidenceDegraded).toBe(false);
  });

  it("carries the reader's §7.13 posture into the row's redaction record", async () => {
    registerBoth([msw("financial_strain")], []);
    const result = await scoreBereavementRisk(
      { ...EXTRACTION, sudDisclosureAllowed: false },
      request(),
    );
    expect(result.draft.riskFactorsJsonb.redactedCategories).toEqual([SUD_REDACTION_CATEGORY]);
    expect(result.draft.riskFactorsJsonb.factors.activeSubstanceUse).toBe("unknown");
  });
});

// ── D3 Layer 2: the `ai.full` ladder ─────────────────────────────────────────────────────────────────

describe("D3 Layer 2 — the ai.full ladder in front of M32", () => {
  const base = {
    aiFull: true,
    tenantNarrativeOptIn: true,
    m32Bound: true,
    baaExecuted: true,
    dataCompleteness: "complete",
  } as const;

  it("Phase 1: `ai.full` OFF is the outermost gate", () => {
    expect(evaluateBereavementLayer2Eligibility({ ...base, aiFull: false })).toBe(
      "capability_disabled",
    );
  });

  it("reports the FIRST failing gate in priority order", () => {
    expect(evaluateBereavementLayer2Eligibility({ ...base, tenantNarrativeOptIn: false })).toBe(
      "tenant_flag_off",
    );
    expect(evaluateBereavementLayer2Eligibility({ ...base, m32Bound: false })).toBe("m32_unbound");
    expect(evaluateBereavementLayer2Eligibility({ ...base, baaExecuted: false })).toBe(
      "baa_not_executed",
    );
  });

  it("D17: a `minimal` vector is too thin to narrate", () => {
    expect(evaluateBereavementLayer2Eligibility({ ...base, dataCompleteness: "minimal" })).toBe(
      "insufficient_data",
    );
  });

  it("clears when every gate passes", () => {
    expect(evaluateBereavementLayer2Eligibility(base)).toBe("eligible");
  });
});

describe("AI Governance §7.4 — the narrative can never move the tier", () => {
  const complete = evidence({
    mswFactors: [msw("prior_unresolved_loss"), msw("mental_health_history")],
    ppsPoints: [pps("2026-01-01T00:00:00.000Z", 60), pps("2026-06-01T00:00:00.000Z", 20)],
  });

  const CONTEXT = { organizationId: ORG, tenantNarrativeOptIn: true, baaExecuted: true };

  const narrator = {
    async narrate() {
      return {
        narrative: "Survivor presents with converging loss history and limited support.",
        modelRef: "m32:bereavement-risk-narrative@2026-06",
        requestId: "77777777-7777-7777-7777-777777777777",
        // The model claims a HIGHER tier than the rubric. It must not win.
        augmentedScore: 88,
        augmentedTier: "complicated" as const,
      };
    },
  };

  it("mergeAugmentation writes the model's tier to `augmented_tier` and returns the rubric's", () => {
    const merged = mergeAugmentation("moderate", {
      narrative: "n",
      modelRef: "m",
      requestId: "r",
      augmentedScore: 99,
      augmentedTier: "complicated",
    });
    expect(merged.tier).toBe("moderate");
    expect(merged.columns.augmentedTier).toBe("complicated");
    expect(merged.columns.scoreKind).toBe("llm_augmented");
  });

  it("Phase-1 default (no flag reader, no M32) returns the deterministic row untouched", async () => {
    const deterministic = computeDeterministicRisk(complete, request());
    const augmented = await requestAugmentedRisk(deterministic, CONTEXT);
    expect(augmented.applied).toBe(false);
    expect(augmented.reason).toBe("capability_disabled");
    expect(augmented.result.draft.scoreKind).toBe("rule_deterministic");
    expect(augmented.result.draft.augmentedNarrativeRedacted).toBeNull();
  });

  it("`ai.full` ON but M32 unbound stays deterministic", async () => {
    const deterministic = computeDeterministicRisk(complete, request());
    const augmented = await requestAugmentedRisk(deterministic, CONTEXT, {
      flags: {
        async forOrg() {
          return { "ai.full": true };
        },
      },
    });
    expect(augmented.applied).toBe(false);
    expect(augmented.reason).toBe("m32_unbound");
  });

  it("with every gate open, the narrative lands in the augmented columns and `rule_tier` does not move", async () => {
    const deterministic = computeDeterministicRisk(complete, request());
    const augmented = await requestAugmentedRisk(deterministic, CONTEXT, {
      flags: {
        async forOrg() {
          return { "ai.full": true };
        },
      },
      narrative: narrator,
    });
    expect(augmented.applied).toBe(true);
    expect(augmented.result.draft.scoreKind).toBe("llm_augmented");
    expect(augmented.result.draft.augmentedTier).toBe("complicated");
    expect(augmented.result.draft.augmentedModelRef).toBe("m32:bereavement-risk-narrative@2026-06");
    // The deterministic tier is untouched — the whole point of D3's asymmetry.
    expect(augmented.result.draft.ruleTier).toBe(deterministic.draft.ruleTier);
    expect(augmented.tier).toBe(deterministic.draft.ruleTier);
  });

  it("an M32 throw costs the narrative, never the score", async () => {
    const deterministic = computeDeterministicRisk(complete, request());
    const augmented = await requestAugmentedRisk(deterministic, CONTEXT, {
      flags: {
        async forOrg() {
          return { "ai.full": true };
        },
      },
      narrative: {
        async narrate(): Promise<never> {
          throw new Error("m32 timeout");
        },
      },
    });
    expect(augmented.applied).toBe(false);
    expect(augmented.result.draft.ruleTier).toBe(deterministic.draft.ruleTier);
    expect(augmented.result.draft.scoreKind).toBe("rule_deterministic");
  });

  it("an unreachable flag store reads as all-off (fail-closed), not as opted-in", async () => {
    const deterministic = computeDeterministicRisk(complete, request());
    const augmented = await requestAugmentedRisk(deterministic, CONTEXT, {
      flags: {
        async forOrg(): Promise<never> {
          throw new Error("flag store down");
        },
      },
      narrative: narrator,
    });
    expect(augmented.reason).toBe("capability_disabled");
    expect(augmented.result.draft.scoreKind).toBe("rule_deterministic");
  });

  it("a half-populated M32 answer degrades rather than producing a row the §3.3.3 CHECK would refuse", async () => {
    const deterministic = computeDeterministicRisk(complete, request());
    const augmented = await requestAugmentedRisk(deterministic, CONTEXT, {
      flags: {
        async forOrg() {
          return { "ai.full": true };
        },
      },
      narrative: {
        async narrate() {
          return {
            narrative: "n",
            modelRef: "m",
            requestId: "r",
            augmentedScore: null,
            augmentedTier: null,
          };
        },
      },
    });
    expect(augmented.applied).toBe(false);
    expect(augmented.result.draft.scoreKind).toBe("rule_deterministic");
    expect(augmented.result.draft.augmentedModelRef).toBeNull();
  });
});
