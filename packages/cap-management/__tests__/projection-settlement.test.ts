import { describe, expect, it } from "vitest";
import {
  agencyAllocatedCap,
  beneficiaryCountUnit,
  computeAggregateProjection,
  computeInpatientOverage,
  computeInpatientProjection,
  computeSettlement,
  perBeneficiaryAllocatedCap,
  proportionalWeight,
  round4,
  settlementDirection,
} from "../src/index";

const FY25_CAP = 3_446_534; // CMS FY2025 per-beneficiary cap, cents

describe("linear-extrapolation projection (D5)", () => {
  it("projects paid YTD to year-end by the elapsed fraction; full year = actuals", () => {
    const r = computeAggregateProjection({
      paidYtdCents: 1_000_000,
      outstandingBilledCents: 50_000,
      capAmountCents: FY25_CAP,
      capYear: "FY2025",
      asOf: "2025-09-30",
      methodology: "streamlined",
    });
    expect(r.projectedYearEndCents).toBe(1_000_000);
    expect(r.pctOfCap).toBe(round4(1_000_000 / FY25_CAP));
    expect(r.alertBand).toBe("safe");
    expect(r.outstandingBilledCents).toBe(50_000); // surfaced, never in the band (D4)
  });
  it("doubles the projection at the half-year mark", () => {
    // FY2025 window Oct1 2024 – Sep30 2025 (365 days); day 182 (Mar 31 2025) ≈ half.
    const r = computeAggregateProjection({
      paidYtdCents: 2_000_000,
      outstandingBilledCents: 0,
      capAmountCents: FY25_CAP,
      capYear: "FY2025",
      asOf: "2025-03-31",
      methodology: "streamlined",
    });
    expect(r.projectedYearEndCents).toBe(Math.round(2_000_000 / (182 / 365)));
  });
  it("a fresh period with no accruals reads 0% / safe (never null)", () => {
    const r = computeAggregateProjection({
      paidYtdCents: 0,
      outstandingBilledCents: 0,
      capAmountCents: FY25_CAP,
      capYear: "FY2025",
      asOf: "2024-10-15",
      methodology: "proportional",
    });
    expect(r.projectedYearEndCents).toBe(0);
    expect(r.pctOfCap).toBe(0);
    expect(r.alertBand).toBe("safe");
  });
});

describe("methodology (D2 / D10)", () => {
  it("proportional weight is the provider-day share, clamped, with a 1.0 fallback", () => {
    expect(proportionalWeight({ providerElectionDays: 100, totalElectionDaysAllProviders: 200 })).toBe(0.5);
    expect(proportionalWeight({ providerElectionDays: 0, totalElectionDaysAllProviders: 200 })).toBe(1);
    expect(proportionalWeight({ providerElectionDays: 300, totalElectionDaysAllProviders: 200 })).toBe(1);
  });
  it("allocated per-beneficiary cap: full under streamlined, prorated under proportional", () => {
    expect(perBeneficiaryAllocatedCap(FY25_CAP, "streamlined", 0.5)).toBe(FY25_CAP);
    expect(perBeneficiaryAllocatedCap(FY25_CAP, "proportional", 0.5)).toBe(Math.round(FY25_CAP * 0.5));
  });
  it("agency cap is per-bene cap × head-count (streamlined) or × Σweights (proportional)", () => {
    expect(agencyAllocatedCap(FY25_CAP, "streamlined", [1, 1, 1])).toEqual({
      capCents: FY25_CAP * 3,
      effectiveBeneficiaryCount: 3,
    });
    expect(agencyAllocatedCap(FY25_CAP, "proportional", [0.5, 0.5])).toEqual({
      capCents: FY25_CAP,
      effectiveBeneficiaryCount: 1,
    });
    expect(beneficiaryCountUnit("streamlined", 0.4)).toBe(1);
  });
});

describe("inpatient 20% cap (D13)", () => {
  it("computes the GIP+IRC fraction and the band", () => {
    const safe = computeInpatientProjection({ gipDays: 10, ircDays: 5, totalPatientDays: 100, capYear: "FY2025", asOf: "2025-06-01" });
    expect(safe.inpatientDaysYtd).toBe(15);
    expect(safe.inpatientPctYtd).toBe(0.15);
    expect(safe.alertBand).toBe("inpatient_safe");
    const breach = computeInpatientProjection({ gipDays: 15, ircDays: 6, totalPatientDays: 100, capYear: "FY2025", asOf: "2025-06-01" });
    expect(breach.inpatientPctYtd).toBe(0.21);
    expect(breach.alertBand).toBe("inpatient_breach_20");
  });
  it("overage is days above the 20% allowance, recouped at the RHC differential", () => {
    expect(computeInpatientOverage({ inpatientDays: 21, totalPatientDays: 100 })).toEqual({
      allowedDays: 20,
      overageDays: 1,
      overageCents: 0, // no differential wired → days-only, never a wrong cents figure
    });
    expect(
      computeInpatientOverage({ inpatientDays: 25, totalPatientDays: 100, rhcDifferentialCentsPerDay: 50_000 }),
    ).toEqual({ allowedDays: 20, overageDays: 5, overageCents: 250_000 });
  });
});

describe("settlement (§2.1)", () => {
  it("signed aggregate overage drives the owed-direction", () => {
    expect(settlementDirection(100)).toBe("overpayment_owed_to_cms");
    expect(settlementDirection(-100)).toBe("underpayment_owed_to_provider");
    expect(settlementDirection(0)).toBe("balanced");
  });
  it("computes cap, overage, and inpatient recoupment", () => {
    const s = computeSettlement({
      perBeneficiaryCapCents: FY25_CAP,
      methodology: "streamlined",
      beneficiaryWeights: [1, 1],
      paidTotalCents: 7_000_000,
      inpatientDays: 21,
      totalPatientDays: 100,
    });
    expect(s.aggregateCapAmountCents).toBe(FY25_CAP * 2); // 6,893,068
    expect(s.aggregateOverageCents).toBe(7_000_000 - FY25_CAP * 2);
    expect(s.direction).toBe("overpayment_owed_to_cms");
    expect(s.beneficiaryCount).toBe(2);
    expect(s.inpatientOverageDays).toBe(1);
  });
});
