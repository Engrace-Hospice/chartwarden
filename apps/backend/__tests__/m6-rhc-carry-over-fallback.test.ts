// M6's own two-tier RHC carry-over (`rhcCarryOver`, intake/benefit-period.ts) — the readmission screen's `plan.rhc`
// and the claim-range seam's `rhcPriorHospiceDays` fallback (used by M23 when no stays list and no HETS history
// reach it). It must count a transfer-in's SENDING-hospice span (CMS Pub. 100-04 ch. 11 §20.1.3 / §30.2) with the
// same rules as M23's `computeRhcCarryOver`: the transfer day is day 1 of the new stay, a day shared by two spans
// counts once, and a gap of more than 60 days resets the count. Both share `@chartwarden/shared/rhc`.
import { computeRhcCarryOver } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";
import { rhcCarryOver } from "../src/modules/06-admission/intake/benefit-period";
import { buildBenefitPeriodPlan } from "../src/modules/06-admission/intake/readmission-plan";
import {
  type PriorEpisode,
  type RhcPriorStayFact,
  type TransferInSource,
  rhcPriorStayFacts,
} from "../src/modules/06-admission/seams/prior-episodes";

const source = (over: Partial<TransferInSource> = {}): TransferInSource => ({
  transferEventId: "te-1",
  sendingStartedOn: "2025-12-20",
  transferOn: "2026-01-01",
  sendingNpi: "1649726464",
  ...over,
});

const episode = (over: Partial<PriorEpisode> = {}): PriorEpisode => ({
  admissionId: "adm-1",
  patientId: "pat-1",
  admissionState: "discharged",
  startedOn: "2026-01-01",
  endedOn: "2026-01-20",
  endKind: "live_discharge",
  dischargeType: "no_longer_terminal",
  lastRanSequence: 1,
  endingEventId: "de-1",
  transferredIn: null,
  ...over,
});

/** M23's main path over the same facts, internal only (no HETS) — the number the fallback must agree with. */
const mainPathPriorDays = (facts: readonly RhcPriorStayFact[], electionDate: string): number =>
  computeRhcCarryOver({
    electionDate,
    internalStays: facts.map((f) => ({
      start: f.startedOn,
      end: f.endedOn,
      ref: f.admissionId,
      ...(f.otherHospice ? { atOtherHospice: true, hospiceNpi: f.otherHospice.npi } : {}),
    })),
    hets: null,
  }).priorDays;

describe("rhcCarryOver — a transfer-in's sending-hospice span (the fallback count)", () => {
  it("counts the sending hospice's days when the stay being priced is the transfer-in; the transfer day is day 1", () => {
    // Arrange: inherited period began 2026-01-01 at the sending hospice, transfer to us on 2026-02-10.
    const facts = rhcPriorStayFacts([], {
      admissionId: "adm-now",
      transferredIn: source({ sendingStartedOn: "2026-01-01", transferOn: "2026-02-10" }),
    });
    // Act
    const r = rhcCarryOver(facts, "2026-02-10");
    // Assert: Jan 1 … Feb 9 = 40 days; Feb 10 (billed by both hospices) is day 1 of our stay.
    expect(r).toEqual({
      applies: true,
      daysSinceDischarge: 0,
      priorHospiceDays: 40,
      startsAtDay: 41,
      highRateDaysRemaining: 20,
    });
    expect(r.priorHospiceDays).toBe(mainPathPriorDays(facts, "2026-02-10"));
  });

  it("counts the transfer day shared by the sending span and an earlier stay with us once", () => {
    // Arrange: sending 12-20 … 01-01 (13 days), our stay 01-01 … 01-20 (20 days) share 01-01.
    const facts = rhcPriorStayFacts([episode({ transferredIn: source() })]);
    // Act
    const r = rhcCarryOver(facts, "2026-02-01");
    // Assert: 12-20 … 01-20 = 12 + 20 = 32 days, not 33.
    expect(r.priorHospiceDays).toBe(32);
    expect(r.startsAtDay).toBe(33);
    expect(r.daysSinceDischarge).toBe(12);
    expect(r.priorHospiceDays).toBe(mainPathPriorDays(facts, "2026-02-01"));
  });

  it("drops the whole chain (sending span included) after a gap of more than 60 days", () => {
    const facts = rhcPriorStayFacts([episode({ transferredIn: source() })]);
    const r = rhcCarryOver(facts, "2026-03-22"); // 61 days after 01-20
    expect(r).toEqual({
      applies: false,
      daysSinceDischarge: 61,
      priorHospiceDays: 0,
      startsAtDay: 1,
      highRateDaysRemaining: 60,
    });
    expect(mainPathPriorDays(facts, "2026-03-22")).toBe(0);
  });

  it("keeps a sending span that is more than 60 days before the election when the chain reaches it", () => {
    // Arrange: sending 2025-10-01 … 2025-11-01, our stay 11-01 … 12-15, readmitted 2026-01-10 (gap 26).
    const facts = rhcPriorStayFacts([
      episode({
        startedOn: "2025-11-01",
        endedOn: "2025-12-15",
        transferredIn: source({ sendingStartedOn: "2025-10-01", transferOn: "2025-11-01" }),
      }),
    ]);
    // Act
    const r = rhcCarryOver(facts, "2026-01-10");
    // Assert: 10-01 … 12-15 = 76 days, capped at the 60-day high tier.
    expect(r.priorHospiceDays).toBe(60);
    expect(r.highRateDaysRemaining).toBe(0);
    expect(r.priorHospiceDays).toBe(mainPathPriorDays(facts, "2026-01-10"));
  });

  it("is unchanged for plain stays (no transfer-in)", () => {
    const facts = rhcPriorStayFacts([
      episode({ admissionId: "a2", startedOn: "2026-03-01", endedOn: "2026-03-11" }),
      episode({ admissionId: "a1", startedOn: "2026-01-01", endedOn: "2026-01-31" }),
    ]);
    const r = rhcCarryOver(facts, "2026-03-20");
    expect(r.priorHospiceDays).toBe(42);
    expect(r.daysSinceDischarge).toBe(9);
    expect(r.priorHospiceDays).toBe(mainPathPriorDays(facts, "2026-03-20"));
  });
});

describe("buildBenefitPeriodPlan — plan.rhc counts an earlier transfer-in's sending hospice", () => {
  it("adds the sending span of the stay being readmitted from", () => {
    const plan = buildBenefitPeriodPlan({
      patientId: "pat-1",
      episodes: [episode({ transferredIn: source() })],
      readmitFrom: { admissionId: "adm-1", state: "discharged" },
      openAdmissionExists: false,
      closure: { notrFiled: true, finalClaimFiled: false },
      startDate: "2026-02-01",
    });
    expect(plan.rhc.priorHospiceDays).toBe(32);
    expect(plan.rhc.startsAtDay).toBe(33);
  });
});
