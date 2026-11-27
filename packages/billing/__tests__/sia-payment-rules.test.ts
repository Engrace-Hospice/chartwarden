// CW-PI-05 — the Service Intensity Add-on (SIA) measured against the rule as published, not against the code.
//
// The rule these cases are written from (read from the Code of Federal Regulations text, not from the implementation):
//   42 CFR 418.302(b)(1)(i)  the add-on applies to routine home care days in the last 7 days of an election that ends
//                            with the patient discharged due to death;
//   42 CFR 418.302(b)(1)(ii) it equals the continuous home care hourly rate times the direct patient care actually
//                            provided by a registered nurse and/or a social worker, up to 4 hours in total per day;
//   42 CFR 418.302(e)(4)     the CHC hourly rate is the CHC rate divided by 24;
//   CMS Pub. 100-04 ch. 11 §30.2.2 / §30.3  visits are reported in 15-minute units on dated claim lines.
//
// Every expected value below comes from an oracle written here (BigInt arithmetic, UTC calendar arithmetic), never from
// the function under test. Two things the sources leave open stay documented DEFAULTS, pinned as such so a change to
// either is a decision and not a drift: the exact 7.5-minute tie rounds up, and the wage index adjusts the hourly rate's
// labor share and is rounded to whole cents BEFORE the units are multiplied (one more rounding, on the total, after).
// Whether the MAC does the same is a reconciliation question: docs/runbooks/m23-sia-remittance-reconciliation.md.
//
// Fixtures are synthetic. The only published figures are the FY2027 national CHC hourly rates (CMS-1851-CN) already
// held in the rate reference; the wage index and labor share below are invented, not CMS values.
import {
  CMS_NATIONAL_RATES_FY2027,
  SIA_MAX_UNITS_PER_DAY,
  SIA_WINDOW_DAYS,
  type SiaVisitInput,
  applyWageIndexToLaborShare,
  buildVisitLines,
  calculateSia,
  evaluateSiaUnits,
  fiscalYearWindow,
  forecastSia,
  hospiceFiscalYearStartingOf,
  siaAmountCents,
  siaUnitsFromLines,
  visitUnitsForMinutes,
} from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const DAY_MS = 86_400_000;
const isoOf = (epochDay: number): string => new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
const epochDayOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

function rnVisit(over: Partial<SiaVisitInput>): SiaVisitInput {
  return {
    encounterId: "e1",
    serviceDate: "2027-03-10",
    discipline: "rn",
    encounterType: "routine_visit",
    billability: "billable",
    durationMinutes: 60,
    modality: "in_person",
    modalityConfirmed: true,
    ...over,
  };
}

/** A routine-home-care span wide enough to cover every case below. */
const RHC = [{ from: "2020-01-01", to: "2030-12-31" }];

describe("payment = CHC hourly rate x hours of direct care (42 CFR 418.302(b)(1)(ii))", () => {
  const rates = [
    CMS_NATIONAL_RATES_FY2027.hqrpCompliant.chcHourlyRateCents,
    CMS_NATIONAL_RATES_FY2027.hqrpNonCompliant.chcHourlyRateCents,
    1,
    3,
    9_999,
    12_345,
  ];

  it("rounds exactly once, half up, on the total, for 0 to 16 units at every rate", () => {
    for (const rate of rates) {
      for (let units = 0; units <= SIA_MAX_UNITS_PER_DAY; units++) {
        const quarterCents = BigInt(units) * BigInt(rate); // units x rate / 4, still in quarter cents
        const expected = Number((quarterCents + 2n) / 4n); // floor((x + 2) / 4) is half-up for x / 4
        expect(siaAmountCents(units, rate), `${units} units at ${rate}`).toBe(expected);
      }
    }
  });

  it("is not the sum of per-unit rounded amounts (the one rounding is on the total)", () => {
    const rate = CMS_NATIONAL_RATES_FY2027.hqrpNonCompliant.chcHourlyRateCents; // 6911: one unit is 1727.75 cents
    expect(siaAmountCents(1, rate)).toBe(1_728);
    expect(siaAmountCents(3, rate)).toBe(5_183); // 5183.25 rounded once, not 3 x 1728 = 5184
  });

  it("pays at most four hours a day: the daily cap is exactly 4 x the hourly rate", () => {
    expect(SIA_MAX_UNITS_PER_DAY * 15).toBe(4 * 60);
    for (const rate of rates) {
      expect(siaAmountCents(SIA_MAX_UNITS_PER_DAY, rate)).toBe(4 * rate);
    }
    const day = calculateSia({
      deceasedDate: "2027-03-10",
      visits: [rnVisit({ durationMinutes: 600 })], // ten hours of care documented in a day
      rhcPeriods: RHC,
      chcHourlyRateCents: 7_192,
    });
    expect(day.paidUnits).toBe(16);
    expect(day.truncatedUnits).toBe(24);
    expect(day.siaAddOnCents).toBe(4 * 7_192);
  });

  it("refuses a rate or a unit count that is not a plain non-negative number, instead of pricing it", () => {
    expect(() => siaAmountCents(4, -1)).toThrow(RangeError);
    expect(() => siaAmountCents(4, Number.NaN)).toThrow(RangeError);
    expect(() => siaAmountCents(4, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => siaAmountCents(-4, 7_192)).toThrow(RangeError);
    expect(() => siaAmountCents(Number.NaN, 7_192)).toThrow(RangeError);
  });

  it("states an unknown amount as null, never zero: a forecast with no rate carries units and no dollars", () => {
    const forecast = forecastSia({
      visits: [rnVisit({ durationMinutes: 60 })],
      hypotheticalDeathDate: "2027-03-10",
      rhcPeriods: RHC,
    });
    expect(forecast.paidUnits).toBe(4);
    expect(forecast.amountCents).toBeNull();
    // A rate that is known to be zero units is an exact zero: not a guess.
    const none = forecastSia({
      visits: [],
      hypotheticalDeathDate: "2027-03-10",
      rhcPeriods: RHC,
      chcHourlyRateCents: 7_192,
    });
    expect(none.amountCents).toBe(0);
  });
});

describe("the wage-adjusted hourly rate (labor share only, half up, whole cents)", () => {
  /** "1.0523" -> 10523n: four-decimal strings only, so the oracle stays integer. */
  const scaled = (decimal: string): bigint => BigInt(decimal.replace(".", ""));
  const SCALE = 10_000n;
  const oracle = (baseCents: number, factor: string, laborShare: string): number => {
    const f = scaled(factor);
    const l = scaled(laborShare);
    // base x (labor x factor + (1 - labor)), over SCALE^2, rounded half up
    const numerator = BigInt(baseCents) * (l * f + (SCALE - l) * SCALE);
    const denominator = SCALE * SCALE;
    return Number((numerator * 2n + denominator) / (2n * denominator));
  };

  // The labor share is an invented fixture, not a CMS value (the real one is keyed on the tenant's rate table).
  const LABOR = "0.7500";
  it.each([
    ["1.0000", LABOR],
    ["0.8500", LABOR],
    ["1.0523", LABOR],
    ["1.2345", LABOR],
    ["0.5000", "1.0000"],
    ["1.5000", "0.0000"],
    ["1.2345", "1.0000"],
  ])(
    "factor %s, labor share %s equals the integer oracle at the FY2027 national hourly rate",
    (factor, labor) => {
      const base = CMS_NATIONAL_RATES_FY2027.hqrpCompliant.chcHourlyRateCents;
      expect(applyWageIndexToLaborShare(base, factor, labor)).toBe(oracle(base, factor, labor));
    },
  );

  it("rounds an exact half-cent up, and leaves the non-labor share untouched", () => {
    expect(applyWageIndexToLaborShare(3, "0.5000", "1.0000")).toBe(2); // 1.5 -> 2
    expect(applyWageIndexToLaborShare(1_001, "1.5000", "1.0000")).toBe(1_502); // 1501.5 -> 1502
    expect(applyWageIndexToLaborShare(7_192, "9.0000", "0.0000")).toBe(7_192); // labor share 0: the index does nothing
  });

  it("refuses a labor share outside [0, 1] and a negative or non-numeric index", () => {
    expect(() => applyWageIndexToLaborShare(7_192, "1.0000", "1.0001")).toThrow(RangeError);
    expect(() => applyWageIndexToLaborShare(7_192, "1.0000", "-0.1")).toThrow(RangeError);
    expect(() => applyWageIndexToLaborShare(7_192, "-1.0000", "0.7500")).toThrow(RangeError);
    expect(() => applyWageIndexToLaborShare(7_192, "abc", "0.7500")).toThrow();
  });

  it("chains: the hourly rate is rounded to cents first, then units x rate / 4 is rounded once", () => {
    const base = CMS_NATIONAL_RATES_FY2027.hqrpNonCompliant.chcHourlyRateCents;
    const hourly = applyWageIndexToLaborShare(base, "1.0523", LABOR);
    expect(hourly).toBe(oracle(base, "1.0523", LABOR));
    for (const units of [1, 3, 7, 16]) {
      expect(siaAmountCents(units, hourly)).toBe(
        Number((BigInt(units) * BigInt(hourly) + 2n) / 4n),
      );
    }
  });
});

describe("15-minute units (CPM ch. 11 §30.3): every second of a visit, both tie rules", () => {
  // DEFAULT (compliance sign-off pending): an exact half-unit rounds up. The alternative is pinned too.
  it("matches the integer oracle for every whole second from 1 s to 5 h, tie up and tie down", () => {
    for (let seconds = 1; seconds <= 5 * 3_600; seconds++) {
      const minutes = seconds / 60;
      const up = Math.max(1, Math.floor((seconds + 450) / 900));
      const down = Math.max(1, Math.ceil((seconds - 450) / 900));
      expect(visitUnitsForMinutes(minutes, "up"), `${seconds}s up`).toBe(up);
      expect(visitUnitsForMinutes(minutes, "down"), `${seconds}s down`).toBe(down);
    }
  });

  it("pins the boundaries named in plain minutes", () => {
    const table: [number, number, number][] = [
      // minutes, tie up, tie down
      [0.01, 1, 1],
      [7.49, 1, 1],
      [7.5, 1, 1],
      [7.51, 1, 1],
      [14.99, 1, 1],
      [15, 1, 1],
      [22.49, 1, 1],
      [22.5, 2, 1],
      [22.51, 2, 2],
      [37.5, 3, 2],
      [52.5, 4, 3],
      [60, 4, 4],
      [247.49, 16, 16],
      [247.5, 17, 16],
      [247.51, 17, 17],
    ];
    for (const [minutes, up, down] of table) {
      expect(visitUnitsForMinutes(minutes, "up"), `${minutes} min up`).toBe(up);
      expect(visitUnitsForMinutes(minutes, "down"), `${minutes} min down`).toBe(down);
    }
  });

  it("never invents units from no time: zero, negative and non-numeric durations are null", () => {
    for (const minutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(visitUnitsForMinutes(minutes)).toBeNull();
    }
  });
});

describe("the four-hour day, RN and social work combined", () => {
  const evaluate = (visits: SiaVisitInput[], tieBreak: "up" | "down" = "up") =>
    evaluateSiaUnits({
      visits,
      deathDate: "2027-03-10",
      rhcPeriods: RHC,
      policy: { unitTieBreak: tieBreak },
    });

  it("247.49 minutes is 16 units and pays in full; 247.5 is 17, pays 16 and truncates one (tie up)", () => {
    const under = evaluate([rnVisit({ durationMinutes: 247.49 })]);
    expect([under.paidUnits, under.truncatedUnits]).toEqual([16, 0]);
    const tie = evaluate([rnVisit({ durationMinutes: 247.5 })]);
    expect([tie.eligibleUnits, tie.paidUnits, tie.truncatedUnits]).toEqual([17, 16, 1]);
    const tieDown = evaluate([rnVisit({ durationMinutes: 247.5 })], "down");
    expect([tieDown.eligibleUnits, tieDown.paidUnits, tieDown.truncatedUnits]).toEqual([16, 16, 0]);
  });

  it("an RN and a social worker share one 16-unit day; the next visit past 16 is the one truncated", () => {
    const full = evaluate([
      rnVisit({ encounterId: "a", durationMinutes: 120 }),
      rnVisit({ encounterId: "b", discipline: "msw", durationMinutes: 120 }),
    ]);
    expect([full.paidUnits, full.truncatedUnits]).toEqual([16, 0]);
    const over = evaluate([
      rnVisit({ encounterId: "a", durationMinutes: 120 }),
      rnVisit({ encounterId: "b", discipline: "msw", durationMinutes: 120 }),
      rnVisit({ encounterId: "c", durationMinutes: 1 }),
    ]);
    expect([over.paidUnits, over.truncatedUnits]).toEqual([16, 1]);
    expect(over.visits.find((v) => v.encounterId === "c")?.excluded).toBe("over_daily_cap");
  });

  it("the cap is per calendar day: the same 240 minutes spread over two days pays both", () => {
    const result = evaluate([
      rnVisit({ encounterId: "a", serviceDate: "2027-03-09", durationMinutes: 240 }),
      rnVisit({ encounterId: "b", serviceDate: "2027-03-10", durationMinutes: 240 }),
    ]);
    expect([result.paidUnits, result.truncatedUnits]).toEqual([32, 0]);
  });
});

describe("the last 7 days of life (42 CFR 418.302(b)(1)(i)), on every date of two years", () => {
  const FIRST = epochDayOf("2027-01-01");
  const LAST = epochDayOf("2028-12-31"); // 2028 is a leap year: the sweep crosses 29 February and two new years

  it("counts exactly [death - 6, death] and lists nothing outside [death - 6, death]", () => {
    for (let death = FIRST; death <= LAST; death++) {
      // a 15-minute RN visit on each of death-9 .. death+3
      const visits = Array.from({ length: 13 }, (_, i) =>
        rnVisit({
          encounterId: `v${String(i).padStart(2, "0")}`,
          serviceDate: isoOf(death - 9 + i),
          durationMinutes: 15,
        }),
      );
      const result = evaluateSiaUnits({ visits, deathDate: isoOf(death), rhcPeriods: RHC });
      const expectedDates = Array.from({ length: SIA_WINDOW_DAYS }, (_, i) => isoOf(death - 6 + i));
      expect(result.window, isoOf(death)).toEqual({ from: expectedDates[0], to: isoOf(death) });
      expect(result.visits.map((v) => v.serviceDate)).toEqual(expectedDates);
      expect(result.paidUnits).toBe(SIA_WINDOW_DAYS);
    }
  });

  it("has no window and pays nothing for a patient who has not died", () => {
    const result = evaluateSiaUnits({
      visits: [rnVisit({})],
      deathDate: null,
      rhcPeriods: RHC,
    });
    expect([result.window, result.paidUnits, result.visits]).toEqual([null, 0, []]);
  });

  it("a claim split at a month end loses and double counts nothing, whichever 7 days straddle it", () => {
    for (let death = FIRST; death <= LAST; death++) {
      const deathIso = isoOf(death);
      const startIso = isoOf(death - 6);
      if (startIso.slice(0, 7) === deathIso.slice(0, 7)) continue; // the whole window is in one month
      const monthEnd = isoOf(epochDayOf(`${deathIso.slice(0, 7)}-01`) - 1);
      const visits = Array.from({ length: SIA_WINDOW_DAYS }, (_, i) =>
        rnVisit({ encounterId: `v${i}`, serviceDate: isoOf(death - 6 + i), durationMinutes: 60 }),
      );
      const paid = (claimWindow: { from: string; to: string }) =>
        evaluateSiaUnits({ visits, deathDate: deathIso, rhcPeriods: RHC, claimWindow }).paidUnits;
      const earlier = paid({ from: startIso, to: monthEnd });
      const later = paid({ from: isoOf(epochDayOf(monthEnd) + 1), to: deathIso });
      expect(earlier + later, deathIso).toBe(SIA_WINDOW_DAYS * 4);
      expect(paid({ from: startIso, to: deathIso })).toBe(SIA_WINDOW_DAYS * 4);
    }
  });
});

describe("the rate year is the fiscal year of the date priced (effective dates)", () => {
  it("flips on 1 October, never on 30 September, for every date of four years", () => {
    for (let day = epochDayOf("2025-01-01"); day <= epochDayOf("2028-12-31"); day++) {
      const iso = isoOf(day);
      const year = Number(iso.slice(0, 4));
      const month = Number(iso.slice(5, 7));
      expect(hospiceFiscalYearStartingOf(iso), iso).toBe(month >= 10 ? year : year - 1);
    }
    expect(hospiceFiscalYearStartingOf("2026-09-30")).toBe(2025);
    expect(hospiceFiscalYearStartingOf("2026-10-01")).toBe(2026);
  });

  it("the fiscal year window is 1 October to 30 September, inclusive on both ends", () => {
    expect(fiscalYearWindow(2026)).toEqual({ from: "2026-10-01", to: "2027-09-30" });
    expect(hospiceFiscalYearStartingOf(fiscalYearWindow(2026).from)).toBe(2026);
    expect(hospiceFiscalYearStartingOf(fiscalYearWindow(2026).to)).toBe(2026);
    expect(hospiceFiscalYearStartingOf(isoOf(epochDayOf(fiscalYearWindow(2026).to) + 1))).toBe(
      2027,
    );
  });
});

describe("a video visit: the documented limit, and what stops it", () => {
  // KNOWN LIMIT (register row CW-PI-05): the claim-line builder still emits an in-person RN line for a video visit. The
  // add-on engine does not count it (video is not payable by default), so the lines and the engine disagree, and the
  // claim rule `sia_calculation_correct` fails that claim (lines > counted) until the line is dropped or a policy admits
  // video. This pins both halves so neither moves silently.
  const encounter = (modality: "in_person" | "video") => ({
    encounterId: "e1",
    serviceDate: "2027-03-10",
    billability: "billable" as const,
    discipline: "rn",
    encounterType: "routine_visit",
    durationMinutes: 60,
    modality,
  });
  const lineUnits = (modality: "in_person" | "video") => {
    const lines = buildVisitLines({
      encounters: [encounter(modality)],
      levelOfCarePeriods: [
        {
          levelOfCarePeriodId: "p1",
          levelOfCare: "routine_home_care",
          from: "2027-03-01",
          to: "2027-03-10",
        },
      ],
      inpatientHospiceFacility: false,
    }).lines.map((l) => ({
      serviceDate: l.serviceDate,
      revenueCode: l.revenueCode,
      hcpcs: l.hcpcsCode,
      modifiers: [] as string[],
      unitCount: l.unitCount,
      levelOfCare: l.levelOfCare,
    }));
    return siaUnitsFromLines(lines, { from: "2027-03-04", to: "2027-03-10" }).paidUnits;
  };
  const engineUnits = (modality: "in_person" | "video", videoEligible = false) =>
    evaluateSiaUnits({
      visits: [rnVisit({ modality })],
      deathDate: "2027-03-10",
      rhcPeriods: RHC,
      policy: { videoEligible },
    }).paidUnits;

  it("the in-person visit agrees (4 units on the line, 4 counted)", () => {
    expect([lineUnits("in_person"), engineUnits("in_person")]).toEqual([4, 4]);
  });

  it("the video visit disagrees: 4 units on the line, 0 counted, which is what the claim rule fails on", () => {
    expect([lineUnits("video"), engineUnits("video")]).toEqual([4, 0]);
  });

  it("agrees again only if a policy admits video", () => {
    expect(engineUnits("video", true)).toBe(4);
  });
});
