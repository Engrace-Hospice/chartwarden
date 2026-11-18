// @chartwarden/billing — M23 SIA (Service Intensity Add-on) calculator (D6, spec §1.1 / §3.3 `sia_calculation`).
// `calculateSia` evaluates the visits through the shared units engine and prices the payable units; the eligibility
// rules themselves (RHC days, in-person RN/MSW, 15-minute rounding, 16-unit daily cap, window, exclusions) are
// covered exhaustively in sia-units.test.ts. This file pins what the calculator adds on top: the death gate, the
// price (units x CHC hourly / 4, rounded once), and the snapshot fields the service layer persists.
// Pure: no DB/Fastify/BullMQ; everything injected.
import { type SiaCalculationInput, type SiaVisitInput, calculateSia } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const DECEASED = "2026-06-10"; // window = [2026-06-04, 2026-06-10]
const CHC_HOURLY = 7_192; // FY2027 national CHC hourly, $71.92 (the wage-adjusted rate is injected in production)
const RHC = [{ from: "2026-05-01", to: "2026-06-10" }];

function visit(over: Partial<SiaVisitInput>): SiaVisitInput {
  return {
    encounterId: "enc-1",
    serviceDate: DECEASED,
    discipline: "rn",
    encounterType: "routine_visit",
    billability: "billable",
    durationMinutes: 60,
    modality: "in_person",
    modalityConfirmed: true,
    ...over,
  };
}

function input(over: Partial<SiaCalculationInput>): SiaCalculationInput {
  return {
    deceasedDate: DECEASED,
    visits: [visit({})],
    rhcPeriods: RHC,
    chcHourlyRateCents: CHC_HOURLY,
    ...over,
  };
}

describe("calculateSia", () => {
  it("yields no SIA for a patient who has not died", () => {
    const r = calculateSia(input({ deceasedDate: null }));
    expect(r.present).toBe(false);
    expect(r.siaAddOnCents).toBe(0);
    expect(r.windowStart).toBeNull();
    expect(r.windowEnd).toBeNull();
  });

  it("keeps the persisted minutes total a whole number when an EVV bracket has seconds (it feeds an integer column)", () => {
    // 10:00:00 -> 10:37:01 is 37.0167 minutes, and 22.5 min is exactly half a minute: neither may reach `integer`.
    const r = calculateSia(
      input({
        visits: [
          visit({ encounterId: "a", durationMinutes: 37 + 1 / 60 }),
          visit({ encounterId: "b", serviceDate: "2026-06-09", durationMinutes: 22.5 }),
        ],
      }),
    );
    expect(Number.isInteger(r.totalQualifyingMinutes)).toBe(true);
    expect(r.totalQualifyingMinutes).toBe(60); // 37.0167 + 22.5 = 59.5167 -> 60, rounded ONCE on the sum
    // The exact per-visit minutes survive for the snapshot; units (what is paid) are rounded per visit.
    // (date order: the 22.5-minute visit is the day before)
    expect(r.qualifyingVisits.map((v) => v.durationMinutes)).toEqual([22.5, 37 + 1 / 60]);
    expect(r.paidUnits).toBe(2 + 2); // 37.0 min -> 2 units, 22.5 min -> 2 units (tie rounds up)
  });

  it("prices one in-person RN hour as 4 units x CHC hourly / 4 = one hourly rate", () => {
    const r = calculateSia(input({}));
    expect(r).toMatchObject({
      present: true,
      paidUnits: 4,
      eligibleUnits: 4,
      truncatedUnits: 0,
      siaAddOnCents: CHC_HOURLY,
      windowStart: "2026-06-04",
      windowEnd: "2026-06-10",
      totalQualifyingMinutes: 60,
    });
  });

  it("rounds each visit to 15-minute units, then prices the total once", () => {
    // 47 min -> 3 units, 95 min -> 6 units: 9 units = 2.25 h x $71.92 = $161.82
    const r = calculateSia(
      input({
        visits: [
          visit({ encounterId: "a", durationMinutes: 47 }),
          visit({ encounterId: "b", discipline: "msw", durationMinutes: 95 }),
        ],
      }),
    );
    expect(r.paidUnits).toBe(9);
    expect(r.siaAddOnCents).toBe(16_182);
  });

  it("pays at most 16 units a day and reports the truncated units and the visit that lost them", () => {
    const r = calculateSia(
      input({
        visits: [
          visit({ encounterId: "a", durationMinutes: 240 }),
          visit({ encounterId: "b", discipline: "msw", durationMinutes: 60 }),
        ],
      }),
    );
    expect(r.paidUnits).toBe(16);
    expect(r.truncatedUnits).toBe(4);
    expect(r.evaluation.visits.find((v) => v.encounterId === "b")?.excluded).toBe("over_daily_cap");
  });

  it("is not payable when only telephonic visits exist, but still reports a candidate so billing sees why", () => {
    const r = calculateSia(input({ visits: [visit({ modality: "telephonic" })] }));
    expect(r.present).toBe(false);
    expect(r.hasCandidateVisits).toBe(true);
    expect(r.siaAddOnCents).toBe(0);
    expect(r.evaluation.visits[0]?.excluded).toBe("modality_telephonic");
  });

  it("reports no candidate when only ineligible disciplines visited", () => {
    const r = calculateSia(input({ visits: [visit({ discipline: "chha" })] }));
    expect(r.present).toBe(false);
    expect(r.hasCandidateVisits).toBe(false);
  });

  it("lists only the counted visits as qualifying visits", () => {
    const r = calculateSia(
      input({
        visits: [visit({ encounterId: "yes" }), visit({ encounterId: "no", discipline: "lpn" })],
      }),
    );
    expect(r.qualifyingVisits.map((v) => v.encounterId)).toEqual(["yes"]);
    expect(r.qualifyingVisits[0]).toMatchObject({ discipline: "rn", units: 4, paidUnits: 4 });
  });
});
