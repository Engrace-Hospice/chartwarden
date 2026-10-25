import { describe, expect, it } from "vitest";
import { addDays, daysInclusive, eachDay, toRanges } from "../domain/dates";
import { type ContractRateFact, expectedPaymentCents, priceClaimLines } from "../domain/pricing";

const rate = (over: Partial<ContractRateFact> = {}): ContractRateFact => ({
  id: "r1",
  levelOfCare: "routine_home_care",
  revenueCode: "0651",
  rateBasis: "per_diem",
  rateCents: 20_000,
  percentOfCharges: null,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...over,
});
const rhc = (from: string, to: string) => ({
  levelOfCare: "routine_home_care" as const,
  from,
  to,
  chcDocumentedHours: null,
});
const window = { from: "2026-03-01", to: "2026-03-31" };

describe("dates", () => {
  it("counts inclusive days, crosses month ends and leap days, and collapses ranges", () => {
    expect(daysInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(daysInclusive("2028-02-28", "2028-03-01")).toBe(3);
    expect(daysInclusive("2026-03-05", "2026-03-04")).toBe(0);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(toRanges(["2026-03-01", "2026-03-02", "2026-03-05"])).toEqual([
      { from: "2026-03-01", to: "2026-03-02" },
      { from: "2026-03-05", to: "2026-03-05" },
    ]);
    expect(eachDay("2026-03-01", "2026-03-03")).toHaveLength(3);
  });
});

describe("priceClaimLines", () => {
  it("prices a per-diem stretch as days x rate under the contract's own revenue code", () => {
    const lines = priceClaimLines({
      window,
      periods: [rhc("2026-02-01", "2026-04-30")],
      rates: [rate({ revenueCode: "0652" })],
      hcpcsCode: null,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      units: 31,
      unitRateCents: 20_000,
      lineChargeCents: 620_000,
      revenueCode: "0652",
      unpricedReason: null,
    });
    expect(expectedPaymentCents(lines)).toBe(620_000);
  });

  it("clips periods to the window and splits at every rate change, leaving an unrated gap unpriced", () => {
    const lines = priceClaimLines({
      window,
      periods: [rhc("2026-03-01", "2026-03-31")],
      rates: [
        rate({
          id: "a",
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-03-10",
          rateCents: 10_000,
        }),
        rate({ id: "b", effectiveFrom: "2026-03-16", effectiveTo: null, rateCents: 30_000 }),
      ],
      hcpcsCode: null,
    });
    expect(
      lines.map((l) => [l.serviceFrom, l.serviceTo, l.contractRateId, l.unpricedReason]),
    ).toEqual([
      ["2026-03-01", "2026-03-10", "a", null],
      ["2026-03-11", "2026-03-15", null, "no_contract_rate"],
      ["2026-03-16", "2026-03-31", "b", null],
    ]);
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
    expect(expectedPaymentCents(lines)).toBeNull();
  });

  it("only uses rate rows of the same level of care", () => {
    const lines = priceClaimLines({
      window,
      periods: [rhc("2026-03-01", "2026-03-05")],
      rates: [rate({ levelOfCare: "general_inpatient", revenueCode: "0656" })],
      hcpcsCode: null,
    });
    expect(lines[0]).toMatchObject({ unpricedReason: "no_contract_rate", revenueCode: "0651" });
  });

  it("refuses to price percent-of-charges and an undocumented per-hour period, and prices whole documented hours", () => {
    const pct = priceClaimLines({
      window,
      periods: [rhc("2026-03-01", "2026-03-02")],
      rates: [
        rate({ rateBasis: "percent_of_charges", rateCents: null, percentOfCharges: "85.00" }),
      ],
      hcpcsCode: null,
    });
    expect(pct[0]?.unpricedReason).toBe("percent_of_charges_needs_charge_source");
    const chc = (hours: number | null) =>
      priceClaimLines({
        window,
        periods: [
          {
            levelOfCare: "continuous_home_care",
            from: "2026-03-01",
            to: "2026-03-02",
            chcDocumentedHours: hours,
          },
        ],
        rates: [
          rate({
            levelOfCare: "continuous_home_care",
            revenueCode: "0652",
            rateBasis: "per_hour",
            rateCents: 5_000,
          }),
        ],
        hcpcsCode: null,
      });
    expect(chc(null)[0]?.unpricedReason).toBe("chc_hours_not_documented");
    expect(chc(10.5)[0]?.unpricedReason).toBe("chc_hours_not_documented");
    expect(chc(16)[0]).toMatchObject({ units: 16, lineChargeCents: 80_000, unpricedReason: null });
  });

  it("does not price a per-hour period that a rate change split", () => {
    const lines = priceClaimLines({
      window,
      periods: [
        {
          levelOfCare: "continuous_home_care",
          from: "2026-03-01",
          to: "2026-03-10",
          chcDocumentedHours: 24,
        },
      ],
      rates: [
        rate({
          id: "a",
          levelOfCare: "continuous_home_care",
          revenueCode: "0652",
          rateBasis: "per_hour",
          rateCents: 5_000,
          effectiveTo: "2026-03-05",
        }),
        rate({
          id: "b",
          levelOfCare: "continuous_home_care",
          revenueCode: "0652",
          rateBasis: "per_hour",
          rateCents: 6_000,
          effectiveFrom: "2026-03-06",
        }),
      ],
      hcpcsCode: null,
    });
    expect(lines.map((l) => l.unpricedReason)).toEqual([
      "chc_hours_not_documented",
      "chc_hours_not_documented",
    ]);
  });

  it("returns no lines for a period outside the window", () => {
    expect(
      priceClaimLines({
        window,
        periods: [rhc("2026-05-01", "2026-05-31")],
        rates: [rate()],
        hcpcsCode: null,
      }),
    ).toEqual([]);
    expect(expectedPaymentCents([])).toBeNull();
  });
});
