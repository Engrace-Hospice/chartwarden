// GET /billing/eligibility/hospice-periods — the pure projection + its TypeBox/OpenAPI response contract.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { eligibilityParsedPayload } from "../jobs/m23-jobs";
import { HospicePeriodsResponseSchema } from "../routes/billing-typebox";
import { type EligibilityCheckRowLike, projectHospicePeriods } from "../routes/hospice-periods";

const PATIENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-20T00:00:00.000Z");

const payload = eligibilityParsedPayload({
  outcome: "active_part_a",
  reason: null,
  partAEffectiveDate: "2005-04-01",
  partATerminationDate: null,
  hospiceElectionOnFile: true,
  hospice: {
    periods: [
      {
        kind: "benefit_period",
        periodNumber: 1,
        startDate: "2023-01-10",
        endDate: "2023-04-09",
        hospiceNpi: "1649726464",
        revocationOrDischargeDate: "2023-04-09",
        revocationCode: "1",
        daysUsed: 90,
      },
      {
        kind: "election",
        periodNumber: null,
        startDate: "2023-01-10",
        endDate: null,
        hospiceNpi: "1649726464",
        revocationOrDischargeDate: null,
        revocationCode: "1",
        daysUsed: null,
      },
    ],
    electionOpen: false,
    truncated: false,
    billedPeriodCount: 1,
    nextPeriodNumber: 2,
    nextPeriodBasis: "computed",
  },
  rejectionCodes: [],
  transport: "core_mime",
  correlationId: "t",
  responseFileUri: null,
  staleAt: new Date("2026-11-05T00:00:00.000Z"),
});

const row = (over: Partial<EligibilityCheckRowLike> = {}): EligibilityCheckRowLike => ({
  id: "55555555-5555-4555-8555-555555555555",
  asOfServiceDate: "2026-10-06",
  outcome: "active_part_a",
  parsedPayload: payload,
  checkedAt: new Date("2026-10-06T12:00:00.000Z"),
  staleAt: new Date("2026-11-05T12:00:00.000Z"),
  ...over,
});

describe("projectHospicePeriods", () => {
  it("projects the latest resolved check's hospice history (schema-valid)", () => {
    const view = projectHospicePeriods({
      patientId: PATIENT,
      hetsConfigured: true,
      resolved: row(),
      latest: row(),
      now: NOW,
    });
    expect(view).toMatchObject({
      status: "available",
      outcome: "active_part_a",
      stale: false,
      synthetic: false,
      hospiceHistoryReturned: true,
      hospiceElectionOpen: false,
      nextPeriodNumber: 2,
      nextPeriodBasis: "computed",
      lastAttempt: null,
    });
    expect(view.hospicePeriods).toHaveLength(2);
    expect(Value.Check(HospicePeriodsResponseSchema, view)).toBe(true);
  });

  it("reports a newer failed attempt and staleness, and flags sandbox data as synthetic", () => {
    const failed = row({
      id: "66666666-6666-4666-8666-666666666666",
      outcome: "error",
      parsedPayload: { reason: "HETS_TIMEOUT", hospicePeriods: null },
      checkedAt: new Date("2026-11-10T00:00:00.000Z"),
    });
    const view = projectHospicePeriods({
      patientId: PATIENT,
      hetsConfigured: true,
      resolved: row({ parsedPayload: { ...payload, transport: "sandbox" } }),
      latest: failed,
      now: new Date("2026-11-10T00:00:00.000Z"),
    });
    expect(view.stale).toBe(true);
    expect(view.synthetic).toBe(true);
    expect(view.lastAttempt).toEqual({
      checkId: failed.id,
      outcome: "error",
      checkedAt: "2026-11-10T00:00:00.000Z",
      reason: "HETS_TIMEOUT",
    });
    expect(Value.Check(HospicePeriodsResponseSchema, view)).toBe(true);
  });

  it("distinguishes no-check-on-file from HETS-not-configured", () => {
    const base = { patientId: PATIENT, resolved: null, latest: null, now: NOW };
    const notConfigured = projectHospicePeriods({ ...base, hetsConfigured: false });
    expect(notConfigured).toMatchObject({
      status: "hets_not_configured",
      checkId: null,
      hospicePeriods: [],
      nextPeriodNumber: null,
      hospiceHistoryReturned: false,
    });
    expect(Value.Check(HospicePeriodsResponseSchema, notConfigured)).toBe(true);
    expect(projectHospicePeriods({ ...base, hetsConfigured: true }).status).toBe(
      "no_check_on_file",
    );
  });

  it("treats a pre-hospice-parsing payload as 'no hospice history returned', never a guess", () => {
    const view = projectHospicePeriods({
      patientId: PATIENT,
      hetsConfigured: true,
      resolved: row({ parsedPayload: { partAActive: true, hospiceElectionOnFile: false } }),
      latest: null,
      now: NOW,
    });
    expect(view).toMatchObject({
      status: "available",
      hospiceHistoryReturned: false,
      hospiceElectionOpen: null,
      nextPeriodNumber: null,
      nextPeriodBasis: null,
    });
  });

  it("drops malformed period entries and never exposes a non-computed next number", () => {
    const view = projectHospicePeriods({
      patientId: PATIENT,
      hetsConfigured: true,
      resolved: row({
        parsedPayload: {
          ...payload,
          hospicePeriods: [{ kind: "bogus" }, ...(payload.hospicePeriods as unknown[])],
          hospiceNextPeriodNumber: 7,
          hospiceNextPeriodBasis: "election_open",
        },
      }),
      latest: null,
      now: NOW,
    });
    expect(view.hospicePeriods).toHaveLength(2);
    expect(view.nextPeriodNumber).toBeNull();
    expect(view.nextPeriodBasis).toBe("election_open");
  });
});
