// @wardenx/bereavement — M16-T01 policy / cadence / rubric / gate unit tests.
//
// The CoP 418.64(d) invariants the whole module rests on: the D4 13-month death-anchored window and its
// tighten-only cadence floor, the D3/D17 `unknown`-aware deterministic scorer (including the §7.3 worked
// example and the §7.17 partial-data case), the D7/D9 closure + opt-out windows, and the D18
// external-source first-contact gate.
import { describe, expect, it } from "vitest";

import type { BereavementRiskFactorInputs } from "@wardenx/types";

import {
  BEREAVEMENT_CADENCE_FLOOR,
  BEREAVEMENT_RISK_WEIGHTS,
  BEREAVEMENT_WINDOW_DAYS,
  CLOSEOUT_CADENCE_ITEM,
  COMPLICATED_GRIEF_SCREEN_THRESHOLD,
  OUTREACH_DUE_AT_CEILING_DAYS,
  applyCosignReceipt,
  bereavementWindowEnd,
  computeBereavementRiskScore,
  effectiveCadence,
  evaluateExternalSourceGate,
  isOutreachDueAtWithinCeiling,
  isPermittedModalitySubstitution,
  isWithinBereavementWindow,
  isWithinOptOutRescindWindow,
  promoteTierForGriefScreen,
  requiresCloseCosign,
  requiresSourceEncounter,
  shouldCloseAsDeclined,
  validateTenantCadence,
} from "../src";

const DEATH_DATE = "2026-01-15";

const ALL_UNKNOWN: BereavementRiskFactorInputs = {
  ambivalentRelationship: "unknown",
  suddenUnexpectedDeath: "unknown",
  priorUnresolvedLoss: "unknown",
  preExistingMentalHealth: "unknown",
  socialIsolation: "unknown",
  financialStrain: "unknown",
  primaryCaregiverRole: "unknown",
  activeSubstanceUse: "unknown",
};

describe("D4 — the 13-month death-anchored window", () => {
  it("runs half-open from the death date to day 396", () => {
    expect(BEREAVEMENT_WINDOW_DAYS).toBe(396);
    expect(isWithinBereavementWindow(DEATH_DATE, "2026-01-15T00:00:00.000Z")).toBe(true);
    expect(isWithinBereavementWindow(DEATH_DATE, "2027-02-14T23:59:59.000Z")).toBe(true);
    // day 396 is the close-out day itself — the auto-close worker fires ON it.
    expect(isWithinBereavementWindow(DEATH_DATE, bereavementWindowEnd(DEATH_DATE))).toBe(false);
    expect(isWithinBereavementWindow(DEATH_DATE, "2026-01-14T12:00:00.000Z")).toBe(false);
  });

  it("allows an outreach due_at inside the window + the 30-day grace and no further", () => {
    expect(OUTREACH_DUE_AT_CEILING_DAYS).toBe(426);
    expect(isOutreachDueAtWithinCeiling(DEATH_DATE, "2027-03-16T00:00:00.000Z")).toBe(true); // day 425
    expect(isOutreachDueAtWithinCeiling(DEATH_DATE, "2027-03-18T00:00:00.000Z")).toBe(false); // day 427
    expect(isOutreachDueAtWithinCeiling(DEATH_DATE, "2026-01-14T00:00:00.000Z")).toBe(false);
  });

  it("refuses a malformed date rather than silently passing every window check", () => {
    expect(() => isWithinBereavementWindow("not-a-date", "2026-02-01T00:00:00.000Z")).toThrow(
      RangeError,
    );
  });
});

describe("D4 — the per-tier cadence floor is cumulative and tighten-only", () => {
  it("never loses a contact as the tier rises", () => {
    const marks = (tier: "low" | "moderate" | "high" | "complicated") =>
      new Set(BEREAVEMENT_CADENCE_FLOOR[tier].map((i) => i.mark));
    for (const [lower, higher] of [
      ["low", "moderate"],
      ["moderate", "high"],
      ["high", "complicated"],
    ] as const) {
      for (const mark of marks(lower)) expect(marks(higher).has(mark)).toBe(true);
    }
    // moderate's 9-month milestone survives at high and complicated (D4 beats the §7.4 narrative).
    expect(marks("high").has("nine_month")).toBe(true);
  });

  it("puts every floor contact inside the due_at ceiling and the closeout on day 396", () => {
    for (const tier of ["low", "moderate", "high", "complicated"] as const) {
      for (const item of BEREAVEMENT_CADENCE_FLOOR[tier]) {
        expect(item.offsetDays).toBeGreaterThanOrEqual(0);
        expect(item.offsetDays).toBeLessThanOrEqual(OUTREACH_DUE_AT_CEILING_DAYS);
      }
    }
    expect(CLOSEOUT_CADENCE_ITEM.offsetDays).toBe(BEREAVEMENT_WINDOW_DAYS);
  });

  it("converts the complicated-tier week-1 contact to an in-person visit", () => {
    const highWeek1 = BEREAVEMENT_CADENCE_FLOOR.high.find((i) => i.mark === "week_1");
    const complicatedWeek1 = BEREAVEMENT_CADENCE_FLOOR.complicated.find((i) => i.mark === "week_1");
    expect(highWeek1?.kind).toBe("phone_call");
    expect(complicatedWeek1?.kind).toBe("in_person_visit");
    expect(isPermittedModalitySubstitution("phone_call", "in_person_visit")).toBe(true);
    expect(isPermittedModalitySubstitution("phone_call", "email")).toBe(false);
  });

  it("accepts a tenant policy that adds, moves earlier, or converts upward", () => {
    const tightened = [
      ...BEREAVEMENT_CADENCE_FLOOR.low.map((i) =>
        i.mark === "one_month" ? { ...i, offsetDays: 21, kind: "in_person_visit" as const } : i,
      ),
      {
        mark: "two_month" as const,
        offsetDays: 60,
        kind: "phone_call" as const,
        anniversaryMark: null,
      },
    ];
    expect(validateTenantCadence("low", tightened)).toEqual([]);
    expect(effectiveCadence("low", tightened).map((i) => i.offsetDays)).toEqual([
      7, 21, 60, 90, 180, 365,
    ]);
  });

  it("reports every loosening and refuses to materialize it", () => {
    const loosened = BEREAVEMENT_CADENCE_FLOOR.low
      .filter((i) => i.mark !== "six_month")
      .map((i) =>
        i.mark === "one_month" ? { ...i, offsetDays: 45, kind: "portal_message" as const } : i,
      );
    const violations = validateTenantCadence("low", loosened);
    expect(violations.map((v) => v.code).sort()).toEqual([
      "floor_contact_delayed",
      "floor_contact_dropped",
      "modality_downgraded",
    ]);
    expect(() => effectiveCadence("low", loosened)).toThrow(RangeError);
  });

  it("falls back to the platform floor when the tenant declared no policy", () => {
    expect(effectiveCadence("moderate")).toBe(BEREAVEMENT_CADENCE_FLOOR.moderate);
    expect(effectiveCadence("moderate", [])).toBe(BEREAVEMENT_CADENCE_FLOOR.moderate);
  });
});

describe("D3 / D17 — the deterministic risk rubric", () => {
  it("weights the full 8-factor vector to 1.0", () => {
    const total = Object.values(BEREAVEMENT_RISK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("reproduces the §7.3 worked example at HIGH with full data", () => {
    const result = computeBereavementRiskScore({
      ambivalentRelationship: false,
      suddenUnexpectedDeath: false,
      priorUnresolvedLoss: true,
      preExistingMentalHealth: true,
      socialIsolation: true,
      financialStrain: false,
      primaryCaregiverRole: true,
      activeSubstanceUse: false,
    });
    expect(result.weightedScore).toBeCloseTo(0.51, 10);
    expect(result.tier).toBe("high");
    expect(result.dataCompleteness).toBe("complete");
    expect(result.confidenceBand).toBe("HIGH");
    expect(result.advisoryOnly).toBe(false);
  });

  it("reproduces the §7.17 partial-data case as minimal / LOW", () => {
    const result = computeBereavementRiskScore({
      ...ALL_UNKNOWN,
      primaryCaregiverRole: true,
      socialIsolation: false,
      suddenUnexpectedDeath: false,
    });
    expect(result.knownFactorCount).toBe(3);
    expect(result.unknownFactorCount).toBe(5);
    expect(result.dataCompleteness).toBe("minimal");
    expect(result.confidenceBand).toBe("LOW");
    expect(result.advisoryOnly).toBe(true);
    // 0.10 positive over 0.10 + 0.13 + 0.15 knowable weight.
    expect(result.weightedScore).toBeCloseTo(0.1 / 0.38, 10);
  });

  it("treats `unknown` as neither positive nor negative (never as false)", () => {
    const asUnknown = computeBereavementRiskScore({
      ...ALL_UNKNOWN,
      ambivalentRelationship: true,
    });
    const asFalse = computeBereavementRiskScore({
      ambivalentRelationship: true,
      suddenUnexpectedDeath: false,
      priorUnresolvedLoss: false,
      preExistingMentalHealth: false,
      socialIsolation: false,
      financialStrain: false,
      primaryCaregiverRole: false,
      activeSubstanceUse: false,
    });
    expect(asUnknown.weightedScore).toBe(1);
    expect(asFalse.weightedScore).toBeCloseTo(0.18, 10);
    expect(asUnknown.tier).toBe("high");
    expect(asFalse.tier).toBe("low");
  });

  it("scores an all-unknown vector as 0 / minimal rather than a low-risk finding", () => {
    const result = computeBereavementRiskScore(ALL_UNKNOWN);
    expect(result.weightedScore).toBe(0);
    expect(result.tier).toBe("low");
    expect(result.advisoryOnly).toBe(true);
  });

  it("never reaches `complicated` from the weighted sum — only from a positive screen (D8)", () => {
    const allPositive = computeBereavementRiskScore({
      ambivalentRelationship: true,
      suddenUnexpectedDeath: true,
      priorUnresolvedLoss: true,
      preExistingMentalHealth: true,
      socialIsolation: true,
      financialStrain: true,
      primaryCaregiverRole: true,
      activeSubstanceUse: true,
    });
    expect(allPositive.tier).toBe("high");
    expect(promoteTierForGriefScreen("high", COMPLICATED_GRIEF_SCREEN_THRESHOLD)).toBe(
      "complicated",
    );
    expect(promoteTierForGriefScreen("high", 31)).toBe("complicated");
    expect(promoteTierForGriefScreen("high", 24)).toBe("high");
    expect(promoteTierForGriefScreen("low", null)).toBe("low");
  });
});

describe("D6 / D7 / D9 / D15 — closure, opt-out and the M8 boundary", () => {
  it("requires a supervisor cosign for the five early-close reasons only", () => {
    expect(requiresCloseCosign("tenant_offboarding")).toBe(true);
    expect(requiresCloseCosign("other_early")).toBe(true);
    expect(requiresCloseCosign("thirteen_month_completion")).toBe(false);
    expect(requiresCloseCosign("all_contacts_declined")).toBe(false);
    expect(requiresCloseCosign("patient_opt_out_post_creation")).toBe(false);
  });

  it("closes as declined only when EVERY contact opted out", () => {
    expect(shouldCloseAsDeclined(["opted_out", "opted_out"])).toBe(true);
    expect(shouldCloseAsDeclined(["opted_out", "deceased"])).toBe(false);
    expect(shouldCloseAsDeclined(["opted_out", "unreachable"])).toBe(false);
    expect(shouldCloseAsDeclined([])).toBe(false);
  });

  it("holds the self-service opt-out rescind window at 90 days", () => {
    expect(
      isWithinOptOutRescindWindow("2026-03-01T00:00:00.000Z", "2026-05-30T00:00:00.000Z"),
    ).toBe(true);
    expect(
      isWithinOptOutRescindWindow("2026-03-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"),
    ).toBe(false);
  });

  it("backs only the in-person visit with an M8 encounter (D15)", () => {
    expect(requiresSourceEncounter("in_person_visit")).toBe(true);
    for (const kind of [
      "phone_call",
      "sympathy_card",
      "sympathy_letter",
      "anniversary_letter",
      "email",
      "portal_message",
    ] as const) {
      expect(requiresSourceEncounter(kind)).toBe(false);
    }
  });
});

describe("D18 — the external-source first-contact gate", () => {
  const pending = {
    sourceProposalId: "hl7p_w24",
    sourceMessageId: "msg_1",
    sourceFacilityMdmId: "mdm_1",
    sourceFacilityName: "St. Mary's Hospital",
    ackReceivedAt: "2026-06-10T10:00:00.000Z",
    cosignStatus: "pending" as const,
  };
  const noFacts = { hasDeathCertificate: false, hasCoordinatorAcknowledgment: false };

  it("never gates an internal-clinician-recorded death (D16)", () => {
    expect(evaluateExternalSourceGate(null, null, noFacts)).toEqual({ allowed: true });
  });

  it("refuses first contact while the medical-director cosign is pending (W-M16-09)", () => {
    expect(evaluateExternalSourceGate(pending, null, noFacts)).toEqual({
      allowed: false,
      code: "external_source_cosign_pending",
    });
  });

  it("releases the gate on cosign and re-gates on a tenant tightening (W-M16-11 variant)", () => {
    const cosigned = applyCosignReceipt(pending, {
      sourceProposalId: "hl7p_w24",
      cosignedAt: "2026-06-12T10:30:00.000Z",
      medicalDirectorMembershipId: "mem_md_engrace_01",
    });
    expect(cosigned?.cosignStatus).toBe("cosigned");
    expect(evaluateExternalSourceGate(cosigned, null, noFacts)).toEqual({ allowed: true });
    expect(
      evaluateExternalSourceGate(
        cosigned,
        { requireDeathCertificateUploaded: true, requireCoordinatorAcknowledgment: false },
        noFacts,
      ),
    ).toEqual({ allowed: false, code: "tenant_gate_death_certificate_missing" });
    expect(
      evaluateExternalSourceGate(
        cosigned,
        { requireDeathCertificateUploaded: true, requireCoordinatorAcknowledgment: true },
        { hasDeathCertificate: true, hasCoordinatorAcknowledgment: false },
      ),
    ).toEqual({ allowed: false, code: "tenant_gate_coordinator_acknowledgment_missing" });
  });

  it("makes a redelivered or mismatched cosign receipt a no-op (worker idempotency)", () => {
    const cosigned = applyCosignReceipt(pending, {
      sourceProposalId: "hl7p_w24",
      cosignedAt: "2026-06-12T10:30:00.000Z",
      medicalDirectorMembershipId: "mem_md_engrace_01",
    });
    expect(
      applyCosignReceipt(cosigned, {
        sourceProposalId: "hl7p_w24",
        cosignedAt: "2026-06-13T10:30:00.000Z",
        medicalDirectorMembershipId: "mem_md_other",
      }),
    ).toBeNull();
    expect(
      applyCosignReceipt(pending, {
        sourceProposalId: "hl7p_other",
        cosignedAt: "2026-06-12T10:30:00.000Z",
        medicalDirectorMembershipId: "mem_md_engrace_01",
      }),
    ).toBeNull();
    expect(
      applyCosignReceipt(null, {
        sourceProposalId: "x",
        cosignedAt: "y",
        medicalDirectorMembershipId: "z",
      }),
    ).toBeNull();
  });

  it("fails closed on a metadata blob with a malformed cosign status", () => {
    const malformed = { ...pending, cosignStatus: "" as unknown as "pending" };
    expect(evaluateExternalSourceGate(malformed, null, noFacts)).toEqual({
      allowed: false,
      code: "external_source_cosign_pending",
    });
  });
});
