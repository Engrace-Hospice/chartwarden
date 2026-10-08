// GAP-037 — the pure per-patient projection (cap denominator, methodology weight, freeze-at-death).
import { describe, expect, it } from "vitest";
import { projectPatient } from "../routes/patient-projections";

const CAP = 3_536_144;
const input = {
  capYear: "FY2026",
  perBeneficiaryCapCents: CAP,
  methodology: "streamlined" as const,
  asOf: "2026-04-01",
};
const row = (over: Partial<Parameters<typeof projectPatient>[0]> = {}) => ({
  patientId: "p1",
  paidCents: 1_000_000,
  outstandingBilledCents: 0,
  methodologyWeight: "1.000000",
  deceasedAt: null,
  ...over,
});

describe("projectPatient", () => {
  it("extrapolates a living patient's run-rate against the full per-beneficiary cap", () => {
    const p = projectPatient(row(), input);
    expect(p.capAmountCents).toBe(CAP);
    expect(p.projectedYearEndCents).toBeGreaterThan(1_000_000);
  });

  it("applies the proportional weight to the cap denominator only under proportional", () => {
    const prop = projectPatient(row({ methodologyWeight: "0.500000" }), {
      ...input,
      methodology: "proportional",
    });
    expect(prop.capAmountCents).toBe(Math.round(CAP * 0.5));
    expect(projectPatient(row({ methodologyWeight: "0.500000" }), input).capAmountCents).toBe(CAP);
  });

  it("freezes a patient who died on or before asOf: projected year-end equals paid-to-date", () => {
    const dead = projectPatient(row({ deceasedAt: "2026-01-15" }), input);
    expect(dead.projectedYearEndCents).toBe(1_000_000);
    expect(dead.pctOfCap).toBeCloseTo(1_000_000 / CAP, 3);
  });

  it("does not freeze for a death date after asOf", () => {
    const later = projectPatient(row({ deceasedAt: "2026-09-01" }), input);
    expect(later.projectedYearEndCents).toBeGreaterThan(1_000_000);
  });

  it("bands the patient by their own utilisation", () => {
    expect(
      projectPatient(row({ paidCents: Math.round(CAP * 0.96), deceasedAt: "2026-01-01" }), input)
        .alertBand,
    ).toBe("warn_95");
    expect(projectPatient(row({ paidCents: 10, deceasedAt: "2026-01-01" }), input).alertBand).toBe(
      "safe",
    );
  });
});
