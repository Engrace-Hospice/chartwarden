// @wardenx/cost-report — PURE allocation-input assembler unit suite (§3.1 / D8). Asserts the DB→input shaping
// of `assembleAllocationInputs`: Worksheet A → step-down direct centers (tie-out-safe), Worksheet C → ancillary
// RCC inputs, statistic census → Worksheet D day cells (unknown LOC/program dropped), and E-1/D + the M26 cap →
// the settlement input (cap lines present ONLY when M26 is bound). Plus the defensive contract: an empty report
// shapes into inputs the deterministic chain runs over WITHOUT a throw and ties out.
import { describe, expect, it } from "vitest";
import {
  type RawAllocationInputs,
  apportionAncillary,
  apportionToPrograms,
  assembleAllocationInputs,
  computeSettlement,
  stepDownAllocate,
} from "../src/allocation";
import type { CapContext } from "../src/validation/types";

const CAP: CapContext = {
  aggregateCapCents: 5_000_000,
  aggregatePaymentsCents: 5_750_000,
  inpatientDays: 120,
  totalMedicareDays: 1_000,
};

function raw(over: Partial<RawAllocationInputs> = {}): RawAllocationInputs {
  return {
    fiscalYearInt: 2026,
    worksheets: [],
    monthlyBreakdown: null,
    cap: { capContext: null },
    ...over,
  };
}

describe("assembleAllocationInputs — step-down (Worksheet A)", () => {
  it("maps A cost centers to DIRECT step-down centers with empty bases that tie out", () => {
    const inputs = assembleAllocationInputs(
      raw({
        worksheets: [
          {
            worksheetCode: "A",
            data: {
              costCenters: [
                { code: "D1", name: "Nursing", totalCostsCents: 200_000 },
                { code: "D2", name: "Pharmacy", totalCostsCents: 300_000 },
              ],
            },
          },
        ],
      }),
    );
    expect(inputs.stepDown.costCenters).toEqual([
      { code: "D1", name: "Nursing", directCostCents: 200_000, isOverhead: false },
      { code: "D2", name: "Pharmacy", directCostCents: 300_000, isOverhead: false },
    ]);
    expect(inputs.stepDown.statisticalBases).toEqual([]);
    // Direct-only pass conserves the pool exactly (nothing fabricated, no money lost).
    const b = stepDownAllocate(inputs.stepDown);
    expect(b.tiesOut).toBe(true);
    expect(b.totalAllocatedToDirectCents).toBe(500_000);
  });

  it("absent Worksheet A → empty centers, trivial tie-out", () => {
    const inputs = assembleAllocationInputs(raw());
    expect(inputs.stepDown.costCenters).toEqual([]);
    expect(stepDownAllocate(inputs.stepDown).tiesOut).toBe(true);
  });
});

describe("assembleAllocationInputs — ancillary (Worksheet C)", () => {
  it("maps C ancillary centers to RCC inputs carrying the Medicare charge line", () => {
    const inputs = assembleAllocationInputs(
      raw({
        worksheets: [
          {
            worksheetCode: "C",
            data: {
              ancillaryCostCenters: [
                {
                  code: "ANC1",
                  name: "Physical Therapy",
                  fullyAllocatedCostCents: 80_000,
                  totalChargesCents: 100_000,
                  medicareChargesCents: 60_000,
                },
              ],
            },
          },
        ],
      }),
    );
    expect(inputs.ancillary.costCenters).toEqual([
      {
        code: "ANC1",
        name: "Physical Therapy",
        totalCostCents: 80_000,
        totalChargesCents: 100_000,
        programCharges: [{ program: "medicare", chargesCents: 60_000 }],
      },
    ]);
    // The pure RCC apportions Medicare cost = (cost/charges) × medicare charges.
    const c = apportionAncillary(inputs.ancillary);
    expect(c.centers[0]!.programLines[0]!.apportionedCostCents).toBe(48_000); // 0.8 × 60_000
  });
});

describe("assembleAllocationInputs — program apportionment (statistic census)", () => {
  it("flattens monthly breakdown into Worksheet D cells, dropping unknown LOC/program keys", () => {
    const inputs = assembleAllocationInputs(
      raw({
        monthlyBreakdown: {
          "2026-01": {
            rhc: { medicare: { patientDays: 30 }, medicaid: { patientDays: 5 } },
            gip: { medicare: { patientDays: 4 } },
            unknown_loc: { medicare: { patientDays: 99 } },
          },
          "2026-02": {
            rhc: { medicare: { patientDays: 28 }, bogus_program: { patientDays: 7 } },
          },
        },
      }),
    );
    const cells = inputs.program.patientDays;
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => ["rhc", "gip"].includes(c.levelOfCare))).toBe(true);
    expect(cells.every((c) => ["medicare", "medicaid"].includes(c.program))).toBe(true);
    expect(cells.some((c) => c.patientDays === 99)).toBe(false); // unknown_loc dropped
    expect(cells.some((c) => c.patientDays === 7)).toBe(false); // bogus_program dropped
    // Per-LOC allowable cost is not modeled upstream → empty → zero apportioned cost, cells still carried.
    expect(inputs.program.levelOfCareCosts).toEqual([]);
    const d = apportionToPrograms(inputs.program);
    expect(d.cells).toHaveLength(4);
    expect(d.programTotals.every((t) => t.apportionedCostCents === 0)).toBe(true);
  });

  it("absent statistics → no cells", () => {
    expect(assembleAllocationInputs(raw()).program.patientDays).toEqual([]);
  });
});

describe("assembleAllocationInputs — settlement (E-1/D + M26 cap)", () => {
  const e1 = {
    worksheetCode: "E-1",
    data: { medicare: { allowablePaymentCents: 4_000_000, interimPaymentsReceivedCents: 3_500_000 } },
  };

  it("reads allowable cost + interim payments from the E-1 Medicare line", () => {
    const s = assembleAllocationInputs(raw({ worksheets: [e1] })).settlement;
    expect(s.medicareAllowableCostCents).toBe(4_000_000);
    expect(s.interimPaymentsCents).toBe(3_500_000);
  });

  it("falls back to Worksheet D Medicare total when E-1 allowable is absent", () => {
    const s = assembleAllocationInputs(
      raw({ worksheets: [{ worksheetCode: "D", data: { medicare: { totalCostCents: 1_234_500 } } }] }),
    ).settlement;
    expect(s.medicareAllowableCostCents).toBe(1_234_500);
    expect(s.interimPaymentsCents).toBe(0);
  });

  it("omits both cap inputs when M26 is unbound (capPositionPending, cap math skipped)", () => {
    const s = assembleAllocationInputs(raw({ worksheets: [e1], cap: { capContext: null } })).settlement;
    expect(s.aggregateCap).toBeUndefined();
    expect(s.inpatientCap).toBeUndefined();
    expect(computeSettlement(s).capPositionPending).toBe(true);
  });

  it("supplies the aggregate + inpatient cap inputs from the live M26 cap context", () => {
    const s = assembleAllocationInputs(raw({ fiscalYearInt: 2026, worksheets: [e1], cap: { capContext: CAP } })).settlement;
    expect(s.aggregateCap).toEqual({
      capYear: 2026,
      medicareBeneficiaryCount: 0,
      aggregateCapAmountCents: 5_000_000,
      totalMedicarePaymentsCents: 5_750_000,
    });
    expect(s.inpatientCap).toEqual({
      capYear: 2026,
      totalMedicareDays: 1_000,
      inpatientDays: 120,
      inpatientCapPercent: 20,
      inpatientPaymentsCents: 0,
    });
    const result = computeSettlement(s);
    expect(result.capPositionPending).toBe(false);
    // Aggregate-cap overage = payments − cap = 5_750_000 − 5_000_000.
    expect(result.aggregateCap!.overageCents).toBe(750_000);
    // Inpatient day cap = floor(1000 × 20%) = 200; 120 ≤ 200 → not exceeded.
    expect(result.inpatientCap!.capDays).toBe(200);
    expect(result.inpatientCap!.exceeded).toBe(false);
  });
});

describe("assembleAllocationInputs — defensive end-to-end", () => {
  it("an empty report shapes into a chain that runs without throwing and ties out", () => {
    const inputs = assembleAllocationInputs(raw());
    expect(() => {
      const b = stepDownAllocate(inputs.stepDown);
      apportionAncillary(inputs.ancillary);
      apportionToPrograms(inputs.program);
      const settlement = computeSettlement(inputs.settlement);
      expect(b.tiesOut).toBe(true);
      expect(settlement.balanceDueToProviderCents).toBe(0);
    }).not.toThrow();
  });

  it("is deterministic: identical raw inputs produce a deeply-equal shaping", () => {
    const r = raw({ worksheets: [{ worksheetCode: "A", data: { costCenters: [{ code: "D1", name: "N", totalCostsCents: 10 }] } }] });
    expect(assembleAllocationInputs(r)).toEqual(assembleAllocationInputs(r));
  });
});
