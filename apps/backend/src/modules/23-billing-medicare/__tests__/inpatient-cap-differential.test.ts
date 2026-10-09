// GAP-038 — the inpatient-cap overage differential M23 supplies to M26's settlement.
import { describe, expect, it } from "vitest";
import {
  fiscalYearStartingForCapYear,
  inpatientDifferentialCentsPerDay,
} from "../services/inpatient-cap-differential";

const rates = (rhc: number, irc: number, gip: number) => ({
  rhcDays1to60PerDiemCents: rhc,
  ircPerDiemCents: irc,
  gipPerDiemCents: gip,
});

describe("inpatientDifferentialCentsPerDay", () => {
  it("weights the inpatient per-diems by the GIP/IRC day mix and subtracts the RHC rate", () => {
    // 30 GIP days @ 100000, 10 IRC days @ 40000 -> 85000 weighted; minus RHC 20000 = 65000.
    expect(
      inpatientDifferentialCentsPerDay([rates(20_000, 40_000, 100_000)], {
        gipDays: 30,
        ircDays: 10,
      }),
    ).toBe(65_000);
  });

  it("averages across provider entities", () => {
    expect(
      inpatientDifferentialCentsPerDay(
        [rates(20_000, 40_000, 100_000), rates(30_000, 40_000, 120_000)],
        {
          gipDays: 1,
          ircDays: 0,
        },
      ),
    ).toBe(85_000);
  });

  it("returns null with no rate row or no inpatient day (cents stay days-only, never a guess)", () => {
    expect(inpatientDifferentialCentsPerDay([], { gipDays: 5, ircDays: 0 })).toBeNull();
    expect(
      inpatientDifferentialCentsPerDay([rates(1, 2, 3)], { gipDays: 0, ircDays: 0 }),
    ).toBeNull();
  });

  it("never goes negative", () => {
    expect(
      inpatientDifferentialCentsPerDay([rates(900, 500, 600)], { gipDays: 1, ircDays: 1 }),
    ).toBe(0);
  });

  it("maps a cap year to the federal fiscal year it ends in", () => {
    expect(fiscalYearStartingForCapYear("FY2026")).toBe(2025);
    expect(fiscalYearStartingForCapYear("2026")).toBeNull();
  });
});
