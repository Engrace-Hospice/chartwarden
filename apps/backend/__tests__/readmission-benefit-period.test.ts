// Readmission workflow — the pure benefit-period rules (intake/benefit-period.ts, intake/readmission-plan.ts) and the
// period-dependent certification / face-to-face rules they feed (activation gate, election-period machine, F2F
// window). 42 CFR 418.21 / 418.22 / 418.24; MBPM ch. 9 §20.1(5)(d); Claims Processing Manual ch. 11.
import { describe, expect, it } from "vitest";
import { evaluateAdmissionReadiness } from "../src/modules/06-admission/intake/activation-gate";
import {
  type PriorEpisodeFacts,
  assertBenefitPeriodEntry,
  assertF2fExceptionReason,
  f2fExceptionSatisfied,
  requirementsForBenefitPeriod,
  rhcCarryOver,
  suggestBenefitPeriod,
} from "../src/modules/06-admission/intake/benefit-period";
import { buildBenefitPeriodPlan } from "../src/modules/06-admission/intake/readmission-plan";
import type { PriorEpisode } from "../src/modules/06-admission/seams/prior-episodes";
import { transitionElectionPeriod } from "../src/modules/06-admission/state-machines/election-period";
import { checkF2fWindow } from "../src/modules/06-admission/state-machines/validation";

const ep = (p: Partial<PriorEpisode> & { admissionId: string }): PriorEpisode => ({
  patientId: "pat",
  admissionState: "discharged",
  startedOn: "2026-01-01",
  endedOn: "2026-02-01",
  endKind: "live_discharge",
  dischargeType: "no_longer_terminal",
  lastRanSequence: 1,
  endingEventId: null,
  ...p,
});

describe("suggestBenefitPeriod — our own history only", () => {
  it("suggests period 1 when the patient was never served", () => {
    // Arrange / Act
    const s = suggestBenefitPeriod([]);
    // Assert
    expect(s).toEqual({
      suggestedSequence: 1,
      basis: "no_history",
      fromAdmissionId: null,
      lastKnownSequence: null,
    });
  });

  it("continues the count after a live discharge (discharged in period 1 → period 2)", () => {
    const s = suggestBenefitPeriod([ep({ admissionId: "a1", lastRanSequence: 1 })]);
    expect(s.suggestedSequence).toBe(2);
    expect(s.basis).toBe("next_after_live_discharge");
    expect(s.fromAdmissionId).toBe("a1");
  });

  it("does not restart on revocation + readmit (revoked in period 2 → period 3)", () => {
    const s = suggestBenefitPeriod([
      ep({ admissionId: "a1", endKind: "revocation", lastRanSequence: 2, dischargeType: null }),
    ]);
    expect(s.suggestedSequence).toBe(3);
    expect(s.basis).toBe("next_after_revocation");
  });

  it("keeps the same period after a transfer out (status 50/51 does not end the period)", () => {
    const s = suggestBenefitPeriod([
      ep({ admissionId: "a1", endKind: "transfer_out", lastRanSequence: 2 }),
    ]);
    expect(s.suggestedSequence).toBe(2);
    expect(s.basis).toBe("same_after_transfer");
  });

  it("treats a move out of the service area (condition code 52) as a live discharge", () => {
    const s = suggestBenefitPeriod([
      ep({ admissionId: "a1", dischargeType: "moved_out_of_service_area", lastRanSequence: 3 }),
    ]);
    expect(s.suggestedSequence).toBe(4);
  });

  it("uses the most recently ended of several earlier admissions", () => {
    const s = suggestBenefitPeriod([
      ep({ admissionId: "old", endedOn: "2025-03-01", lastRanSequence: 1 }),
      ep({ admissionId: "new", endedOn: "2026-02-01", lastRanSequence: 3, endKind: "revocation" }),
      ep({ admissionId: "mid", endedOn: "2025-09-01", lastRanSequence: 2 }),
    ]);
    expect(s.fromAdmissionId).toBe("new");
    expect(s.suggestedSequence).toBe(4);
  });

  it("ignores an earlier admission that never ran a period", () => {
    const s = suggestBenefitPeriod([
      ep({ admissionId: "never", endedOn: "2026-03-01", lastRanSequence: null }),
      ep({ admissionId: "ran", endedOn: "2026-01-01", lastRanSequence: 1 }),
    ]);
    expect(s.fromAdmissionId).toBe("ran");
    expect(s.suggestedSequence).toBe(2);
  });
});

describe("requirementsForBenefitPeriod — everything keys off the chosen number", () => {
  it("period 1: 90 days, attending certifies too, no F2F", () => {
    const r = requirementsForBenefitPeriod(1, "2026-05-01");
    expect(r.periodKind).toBe("ninety_day");
    expect(r.endDate).toBe("2026-07-29");
    expect(r.certification.attendingIfDesignated).toBe(true);
    expect(r.faceToFace.required).toBe(false);
    expect(r.noeDueBy).toBe("2026-05-05"); // admission date = day 1 of 5
    expect(r.initialAssessmentDueBy).toBe("2026-05-03");
    expect(r.comprehensiveAssessmentDueBy).toBe("2026-05-05");
    expect(r.hopeAdmissionA0220).toBe("2026-05-01");
  });

  it("period 2: 90 days, hospice physician only (418.22(c)), no F2F", () => {
    const r = requirementsForBenefitPeriod(2, "2026-05-01");
    expect(r.lengthDays).toBe(90);
    expect(r.certification.attendingIfDesignated).toBe(false);
    expect(r.faceToFace.required).toBe(false);
  });

  it("period 3+: 60 days and a face-to-face in the 30 days before the start, with the 2-day exception", () => {
    const r = requirementsForBenefitPeriod(3, "2026-05-01");
    expect(r.periodKind).toBe("sixty_day");
    expect(r.endDate).toBe("2026-06-29");
    expect(r.faceToFace).toEqual({
      required: true,
      windowStart: "2026-04-01",
      windowEnd: "2026-04-30",
      exceptionWindowEnd: "2026-05-03",
    });
  });
});

describe("assertBenefitPeriodEntry / assertF2fExceptionReason", () => {
  it("accepts a HETS-confirmed number with a past confirmation date", () => {
    expect(() =>
      assertBenefitPeriodEntry(
        { sequence: 2, source: "hets_confirmed", confirmedOn: "2026-05-01" },
        "2026-05-02",
      ),
    ).not.toThrow();
  });
  it.each([0, -1, 1.5, 201])("refuses benefit period %s", (sequence) => {
    expect(() =>
      assertBenefitPeriodEntry({ sequence, source: "staff_entered_unverified" }, "2026-05-02"),
    ).toThrow(/benefit period number/);
  });
  it("requires the confirmation date for hets_confirmed and refuses a future one", () => {
    expect(() =>
      assertBenefitPeriodEntry({ sequence: 2, source: "hets_confirmed" }, "2026-05-02"),
    ).toThrow(expect.objectContaining({ code: "BENEFIT_PERIOD_CONFIRMATION_DATE_REQUIRED" }));
    expect(() =>
      assertBenefitPeriodEntry(
        { sequence: 2, source: "hets_confirmed", confirmedOn: "2026-05-03" },
        "2026-05-02",
      ),
    ).toThrow(expect.objectContaining({ code: "BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID" }));
  });
  it("refuses a confirmation date on an unverified entry", () => {
    expect(() =>
      assertBenefitPeriodEntry(
        { sequence: 2, source: "staff_entered_unverified", confirmedOn: "2026-05-01" },
        "2026-05-02",
      ),
    ).toThrow(expect.objectContaining({ code: "BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID" }));
  });
  it("allows the F2F exception only in period 3+ with a documented reason", () => {
    expect(() => assertF2fExceptionReason(undefined, 1)).not.toThrow();
    expect(() => assertF2fExceptionReason("Weekend emergency admission, no MD", 2)).toThrow(
      expect.objectContaining({ code: "F2F_EXCEPTION_INVALID" }),
    );
    expect(() => assertF2fExceptionReason("short", 3)).toThrow(
      expect.objectContaining({ code: "F2F_EXCEPTION_INVALID" }),
    );
    expect(() => assertF2fExceptionReason("Weekend emergency admission, no MD", 3)).not.toThrow();
  });
});

describe("F2F — the 2-day exceptional-circumstance path (MBPM ch. 9 §20.1(5)(d))", () => {
  it("an encounter on or within 2 days after admission is timely only with a documented exception", () => {
    const base = { periodStart: "2026-05-01", hasOverride: false };
    expect(() => checkF2fWindow({ ...base, encounterDate: "2026-05-02" })).toThrow(
      expect.objectContaining({ code: "F2F_OUTSIDE_WINDOW" }),
    );
    expect(
      checkF2fWindow({ ...base, encounterDate: "2026-05-03", exceptionDocumented: true }),
    ).toEqual({ withinWindow: true });
    expect(() =>
      checkF2fWindow({ ...base, encounterDate: "2026-05-04", exceptionDocumented: true }),
    ).toThrow(expect.objectContaining({ code: "F2F_OUTSIDE_WINDOW" }));
    // the ordinary prior-to window still applies
    expect(checkF2fWindow({ ...base, encounterDate: "2026-04-15" })).toEqual({
      withinWindow: true,
    });
  });

  it("a death within the 2 days deems the F2F complete", () => {
    const base = { startDate: "2026-05-01", exceptionDocumented: true, encounterDate: null };
    expect(f2fExceptionSatisfied({ ...base, deathOn: "2026-05-02" })).toBe(true);
    expect(f2fExceptionSatisfied({ ...base, deathOn: "2026-05-04" })).toBe(false);
    expect(
      f2fExceptionSatisfied({ ...base, exceptionDocumented: false, deathOn: "2026-05-02" }),
    ).toBe(false);
  });

  it("the election-period machine activates a period-3 admission on a documented exception, not without", () => {
    const event = {
      type: "setActive" as const,
      certificationSigned: true,
      admissionActivated: true,
      sequence: 3,
      f2fAttested: false,
      effectiveAt: "2026-05-01",
    };
    expect(() => transitionElectionPeriod("signed", event)).toThrow(
      expect.objectContaining({ code: "F2F_REQUIRED_FOR_RECERT" }),
    );
    expect(transitionElectionPeriod("signed", { ...event, f2fExceptionDocumented: true }).to).toBe(
      "active",
    );
    expect(transitionElectionPeriod("signed", { ...event, sequence: 2 }).to).toBe("active");
  });

  it("the readiness checklist does not block activation on a documented exception", () => {
    const facts = {
      admissionId: "adm",
      patientIdentity: { patientId: "p" },
      admissionDetails: {
        admissionDatePresent: true,
        providerEntityPresent: true,
        locationPresent: true,
      },
      patientPrivacy: { allowed: true },
      noticeOfRights: {
        acknowledged: true,
        acknowledgedAtPresent: true,
        signerValid: true,
        methodValid: true,
      },
      electionStatement: {
        exists: true,
        status: "signed",
        signedAtPresent: true,
        belongsToCurrentPeriod: true,
      },
      cti: { exists: true, status: "signed", hospiceMdSigned: true },
      f2f: {
        required: true,
        exists: false,
        status: null,
        completed: false,
        attestationRequired: true,
        attested: false,
      },
    };
    const blocked = evaluateAdmissionReadiness(facts as never);
    expect(blocked.requirements.find((r) => r.code === "f2f")?.blocking).toBe(true);
    const excepted = evaluateAdmissionReadiness({
      ...facts,
      f2f: { ...facts.f2f, exceptionDocumented: true, exceptionDueBy: "2026-05-03" },
    } as never);
    const f2f = excepted.requirements.find((r) => r.code === "f2f");
    expect(f2f?.blocking).toBe(false);
    expect(f2f?.message).toContain("2026-05-03");
  });
});

describe("rhcCarryOver — two-tier RHC day count across a readmission", () => {
  const stay = (p: Partial<PriorEpisodeFacts>): PriorEpisodeFacts => ({
    admissionId: "a",
    startedOn: "2026-01-01",
    endedOn: "2026-01-31",
    endKind: "live_discharge",
    dischargeType: null,
    lastRanSequence: 1,
    ...p,
  });

  it("carries the prior days when readmitted within 60 days", () => {
    const r = rhcCarryOver([stay({})], "2026-03-01"); // 29 days later
    expect(r).toEqual({
      applies: true,
      daysSinceDischarge: 29,
      priorHospiceDays: 30, // Jan 1 – Jan 30; the live-discharge day is not a billed day
      startsAtDay: 31,
      highRateDaysRemaining: 30,
    });
  });

  it("resets after a gap of more than 60 days", () => {
    const r = rhcCarryOver([stay({})], "2026-04-02"); // 61 days later
    expect(r.applies).toBe(false);
    expect(r.startsAtDay).toBe(1);
    expect(r.priorHospiceDays).toBe(0);
  });

  it("sums a chain of stays each within 60 days of the next", () => {
    const r = rhcCarryOver(
      [
        stay({ admissionId: "a2", startedOn: "2026-03-01", endedOn: "2026-03-11" }),
        stay({ admissionId: "a1", startedOn: "2026-01-01", endedOn: "2026-01-31" }),
        stay({ admissionId: "a0", startedOn: "2025-01-01", endedOn: "2025-02-01" }),
      ],
      "2026-03-20",
    );
    expect(r.priorHospiceDays).toBe(10 + 30);
    expect(r.highRateDaysRemaining).toBe(20);
  });
});

describe("buildBenefitPeriodPlan", () => {
  const base = {
    patientId: "pat",
    openAdmissionExists: false,
    startDate: "2026-03-01",
  };

  it("readmission in period 2: eligible, NOE blocked until the prior NOTR / final claim is filed", () => {
    const plan = buildBenefitPeriodPlan({
      ...base,
      episodes: [ep({ admissionId: "a1" })],
      readmitFrom: { admissionId: "a1", state: "discharged" },
      closure: { notrFiled: false, finalClaimFiled: false },
    });
    expect(plan.readmission).toEqual({ eligible: true, blockers: [] });
    expect(plan.suggestion.suggestedSequence).toBe(2);
    expect(plan.requirements.sequence).toBe(2);
    expect(plan.priorElectionClosure?.status).toBe("not_filed");
    expect(plan.noeBlocked).toBe(true);
    expect(plan.previous?.daysSinceDischarge).toBe(28);
    expect(plan.rhc.applies).toBe(true);
  });

  it("a filed NOTR unblocks the NOE; an unreadable status is unknown and stays blocked", () => {
    const episodes = [ep({ admissionId: "a1" })];
    const filed = buildBenefitPeriodPlan({
      ...base,
      episodes,
      closure: { notrFiled: true, finalClaimFiled: false },
    });
    expect(filed.noeBlocked).toBe(false);
    const unknown = buildBenefitPeriodPlan({ ...base, episodes, closure: null });
    expect(unknown.priorElectionClosure?.status).toBe("unknown");
    expect(unknown.noeBlocked).toBe(true);
  });

  it("computes the requirements of an entered number instead of the suggestion", () => {
    const plan = buildBenefitPeriodPlan({
      ...base,
      episodes: [ep({ admissionId: "a1" })],
      closure: undefined,
      sequence: 3,
    });
    expect(plan.suggestion.suggestedSequence).toBe(2);
    expect(plan.requirements.faceToFace.required).toBe(true);
  });

  it("a death, an open admission and a newer admission block readmission", () => {
    const died = buildBenefitPeriodPlan({
      ...base,
      episodes: [ep({ admissionId: "a1", endKind: "death" })],
      readmitFrom: { admissionId: "a1", state: "bereavement" },
      openAdmissionExists: true,
      newerAdmissionExists: true,
      closure: undefined,
    });
    expect(died.readmission.eligible).toBe(false);
    expect(died.readmission.blockers).toEqual([
      "ENDED_BY_DEATH",
      "OPEN_ADMISSION_EXISTS",
      "NEWER_ADMISSION_EXISTS",
    ]);
    expect(died.priorElectionClosure).toBeNull(); // a death has no live-ended election to close
  });

  it("an admission that has not ended cannot be readmitted from", () => {
    const plan = buildBenefitPeriodPlan({
      ...base,
      episodes: [],
      readmitFrom: { admissionId: "open", state: "active" },
      openAdmissionExists: true,
      closure: undefined,
    });
    expect(plan.readmission.blockers).toContain("NOT_ENDED");
    expect(plan.previous).toBeNull();
    expect(plan.suggestion.suggestedSequence).toBe(1);
  });
});
