// @wardenx/billing — the wage index that prices each level of care: the beneficiary's area for home care, the
// facility's area for inpatient care, never the provider's own unless no geography is bound.
import {
  type PerDiemRateCalculationInput,
  type PerDiemRateTable,
  WageIndexAreaError,
  calculatePerDiemClass,
  wageIndexFactorForLevelOfCare,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";

const areas = { residence: "0.8000", facility: "1.2000" };

describe("wageIndexFactorForLevelOfCare", () => {
  it.each(["routine_home_care", "continuous_home_care"] as const)(
    "prices %s with the beneficiary's residence area",
    (loc) => {
      expect(wageIndexFactorForLevelOfCare(loc, "1.0000", areas)).toBe("0.8000");
    },
  );

  it.each(["general_inpatient_care", "inpatient_respite_care"] as const)(
    "prices %s with the facility's area",
    (loc) => {
      expect(wageIndexFactorForLevelOfCare(loc, "1.0000", areas)).toBe("1.2000");
    },
  );

  it("uses the provider factor only when no area factors are bound", () => {
    expect(wageIndexFactorForLevelOfCare("routine_home_care", "1.0000", undefined)).toBe("1.0000");
  });

  it("throws, never falling back to the provider's index, when the needed area is unresolved", () => {
    expect(() =>
      wageIndexFactorForLevelOfCare("routine_home_care", "1.0000", {
        residence: null,
        facility: "1.2",
      }),
    ).toThrow(WageIndexAreaError);
    expect(() =>
      wageIndexFactorForLevelOfCare("general_inpatient_care", "1.0000", {
        residence: "0.8",
        facility: null,
      }),
    ).toThrow(/facility area.*G8/);
  });
});

const RATE_TABLE: PerDiemRateTable = {
  rhcDays1to60PerDiemCents: 20_000,
  rhcDays61PlusPerDiemCents: 16_000,
  chcHourlyRateCents: 6_667,
  ircPerDiemCents: 50_000,
  gipPerDiemCents: 100_000,
  rhcLaborShare: "0.6600",
  chcLaborShare: "0.6800",
  ircLaborShare: "0.5400",
  gipLaborShare: "0.6400",
};

describe("calculatePerDiemClass when the beneficiary's and the provider's areas differ", () => {
  const input: PerDiemRateCalculationInput = {
    claimServiceFrom: "2026-11-02",
    claimServiceTo: "2026-11-03",
    hospiceAdmissionDate: "2026-10-01",
    levelOfCarePeriods: [
      { levelOfCare: "routine_home_care", from: "2026-11-02", to: "2026-11-02" },
      { levelOfCare: "general_inpatient_care", from: "2026-11-03", to: "2026-11-03" },
    ],
    rateTable: RATE_TABLE,
    wageIndexCcn: "381588",
    wageIndexFiscalYear: 2026,
    wageIndexFactorDecimal: "1.0000", // the provider's own area
  };

  it("prices home and inpatient days by their own areas and records the factor per segment", () => {
    const priced = calculatePerDiemClass({ ...input, wageIndexAreaFactors: areas });
    const [home, inpatient] = priced.segments;
    // 20000 × (0.66 × 0.8 + 0.34) = 17360;  100000 × (0.64 × 1.2 + 0.36) = 112800
    expect(home?.ratePerDiemCents).toBe(17_360);
    expect(home?.wageIndexFactorApplied).toBe("0.8000");
    expect(inpatient?.ratePerDiemCents).toBe(112_800);
    expect(inpatient?.wageIndexFactorApplied).toBe("1.2000");
  });

  it("differs from pricing everything at the provider's index (the old behaviour)", () => {
    const legacy = calculatePerDiemClass(input);
    expect(legacy.segments[0]?.ratePerDiemCents).toBe(20_000);
    expect(legacy.segments[1]?.ratePerDiemCents).toBe(100_000);
    expect(legacy.segments[0]?.wageIndexFactorApplied).toBe("1.0000");
  });

  it("refuses to price a day whose area could not be resolved", () => {
    expect(() =>
      calculatePerDiemClass({
        ...input,
        wageIndexAreaFactors: { residence: null, facility: "1.2" },
      }),
    ).toThrow(WageIndexAreaError);
  });
});
