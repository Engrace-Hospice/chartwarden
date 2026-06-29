import { describe, expect, it } from "vitest";
import { computeCostReportCapAggregate } from "../src/index";

const FY25_CAP = 3_446_534; // CMS FY2025 per-beneficiary cap, cents

describe("computeCostReportCapAggregate (M27 cost-report cap bind, D13)", () => {
  it("pre-settlement: aggregate cap = per-bene cap × count; payments = accrued paid total", () => {
    const r = computeCostReportCapAggregate({
      capYear: "FY2025",
      perBeneficiaryCapCents: FY25_CAP,
      beneficiaryCount: 2,
      paidTotalCents: 7_000_000,
      gipDays: 5,
      ircDays: 2,
      totalPatientDays: 100,
      settledAggregateCapCents: null,
      settledPaidTotalCents: null,
    });
    expect(r).toEqual({
      capYear: "FY2025",
      beneficiaryCount: 2,
      aggregateCapCents: FY25_CAP * 2, // 6,893,068
      aggregatePaymentsCents: 7_000_000,
      inpatientDays: 7,
      totalMedicareDays: 100,
    });
  });

  it("post-settlement: the final settled figures win (they incorporate reopen/true-up)", () => {
    const r = computeCostReportCapAggregate({
      capYear: "FY2025",
      perBeneficiaryCapCents: FY25_CAP,
      beneficiaryCount: 2,
      paidTotalCents: 7_000_000, // accrual-derived
      gipDays: 5,
      ircDays: 2,
      totalPatientDays: 100,
      settledAggregateCapCents: 6_900_000, // settled overrides
      settledPaidTotalCents: 6_950_000,
    });
    expect(r.aggregateCapCents).toBe(6_900_000);
    expect(r.aggregatePaymentsCents).toBe(6_950_000);
    expect(r.inpatientDays).toBe(7);
  });

  it("zero beneficiaries → zero aggregate cap (no division, exact)", () => {
    const r = computeCostReportCapAggregate({
      capYear: "FY2026",
      perBeneficiaryCapCents: FY25_CAP,
      beneficiaryCount: 0,
      paidTotalCents: 0,
      gipDays: 0,
      ircDays: 0,
      totalPatientDays: 0,
      settledAggregateCapCents: null,
      settledPaidTotalCents: null,
    });
    expect(r.aggregateCapCents).toBe(0);
    expect(r.aggregatePaymentsCents).toBe(0);
  });
});
