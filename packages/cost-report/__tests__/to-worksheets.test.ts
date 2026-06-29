// @wardenx/cost-report — PURE allocation-RESULT → derived-worksheet mapper unit suite (§3.1 / D8). Asserts the
// inverse of `assemble-inputs`: the four chain results map to the TypeBox-typed B/C/D/E-1 `data` payloads a
// `cost-allocation-recompute` persists, the cross-worksheet tie flags are stamped from the available facts,
// and every payload round-trips through its worksheet TypeBox schema (Value.Check) so the persisted jsonb is
// schema-valid.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type RawAllocationInputs,
  allocationResultsToWorksheets,
  ancillaryToWorksheetC,
  apportionAncillary,
  apportionToPrograms,
  assembleAllocationInputs,
  computeSettlement,
  programToWorksheetD,
  settlementToWorksheetE1,
  stepDownAllocate,
  stepDownToWorksheetB,
} from "../src/allocation";
import type { CapContext } from "../src/validation/types";
import { WorksheetB } from "../src/worksheets/b";
import { WorksheetC } from "../src/worksheets/c";
import { WorksheetD } from "../src/worksheets/d";
import { WorksheetE1 } from "../src/worksheets/e-1";

const CAP: CapContext = {
  aggregateCapCents: 5_000_000,
  aggregatePaymentsCents: 5_750_000,
  inpatientDays: 120,
  totalMedicareDays: 1_000,
};

function raw(over: Partial<RawAllocationInputs> = {}): RawAllocationInputs {
  return { fiscalYearInt: 2026, worksheets: [], monthlyBreakdown: null, cap: { capContext: null }, ...over };
}

describe("stepDownToWorksheetB", () => {
  it("maps a direct-only step-down to a schema-valid B that ties to A", () => {
    const result = stepDownAllocate({
      costCenters: [
        { code: "D1", name: "Nursing", directCostCents: 200_000, isOverhead: false },
        { code: "D2", name: "Pharmacy", directCostCents: 300_000, isOverhead: false },
      ],
      statisticalBases: [],
    });
    const b = stepDownToWorksheetB(result);
    expect(Value.Check(WorksheetB, b)).toBe(true);
    expect(b.totalFullyAllocatedCostCents).toBe(500_000);
    expect(b.tiesToWorksheetAGrandTotal).toBe(true);
    expect(b.stepDownPreservesTotalExactly).toBe(true);
    expect(b.costCenters.map((c) => c.code)).toEqual(["D1", "D2"]);
    expect(b.allocationColumns).toEqual([]); // no overhead steps with empty bases
  });

  it("records each overhead step as an allocation column and persists only direct centers", () => {
    const result = stepDownAllocate({
      costCenters: [
        { code: "OH1", name: "A&G", directCostCents: 100_000, isOverhead: true },
        { code: "D1", name: "Nursing", directCostCents: 200_000, isOverhead: false },
        { code: "D2", name: "Pharmacy", directCostCents: 300_000, isOverhead: false },
      ],
      statisticalBases: [
        { allocatingCenterCode: "OH1", weights: [{ receivingCenterCode: "D1", statisticValue: 1 }, { receivingCenterCode: "D2", statisticValue: 1 }] },
      ],
    });
    const b = stepDownToWorksheetB(result);
    expect(b.allocationColumns).toEqual([
      { generalServiceCostCenterCode: "OH1", allocationBasis: "", poolAmountCents: 100_000 },
    ]);
    expect(b.costCenters.map((c) => c.code)).toEqual(["D1", "D2"]); // overhead folded out
    expect(b.totalFullyAllocatedCostCents).toBe(600_000);
    const d1 = b.costCenters.find((c) => c.code === "D1")!;
    expect(d1.directCostCents + d1.allocatedOverheadCents).toBe(d1.fullyAllocatedCostCents);
  });
});

describe("ancillaryToWorksheetC", () => {
  it("maps the Medicare RCC line to a schema-valid C, flagging a zero-charge basis", () => {
    const result = apportionAncillary({
      costCenters: [
        { code: "ANC1", name: "PT", totalCostCents: 80_000, totalChargesCents: 100_000, programCharges: [{ program: "medicare", chargesCents: 60_000 }] },
        { code: "ANC2", name: "Lab (no charges)", totalCostCents: 10_000, totalChargesCents: 0, programCharges: [] },
      ],
    });
    const c = ancillaryToWorksheetC(result);
    expect(Value.Check(WorksheetC, c)).toBe(true);
    expect(c.ancillaryCostCenters[0]!.medicareCostCents).toBe(48_000); // 0.8 × 60_000
    expect(c.ancillaryCostCenters[0]!.ratioOfCostToCharges).toBeCloseTo(0.8);
    expect(c.totalMedicareAncillaryCostCents).toBe(48_000);
    expect(c.hasZeroChargeBasisFlag).toBe(true); // ANC2 has cost but zero charges
  });
});

describe("programToWorksheetD", () => {
  it("rolls (program × LOC) cells into per-program columns; ties to B only when costs match", () => {
    const result = apportionToPrograms({
      levelOfCareCosts: [{ levelOfCare: "rhc", allowableCostCents: 100_000 }],
      patientDays: [
        { levelOfCare: "rhc", program: "medicare", month: "2026-01", patientDays: 30 },
        { levelOfCare: "rhc", program: "medicaid", month: "2026-01", patientDays: 10 },
      ],
    });
    const d = programToWorksheetD(result, 100_000);
    expect(Value.Check(WorksheetD, d)).toBe(true);
    expect(d.grandTotalApportionedCostCents).toBe(100_000);
    expect(d.tiesToWorksheetBTotal).toBe(true);
    expect(d.apportionmentPreservesTotalExactly).toBe(true);
    // 30:10 split of 100_000 → 75_000 / 25_000.
    expect(d.medicare.rhcCostCents).toBe(75_000);
    expect(d.medicaid.rhcCostCents).toBe(25_000);
    expect(d.medicare.totalDays).toBe(30);
  });

  it("does NOT tie to B when the apportioned grand total differs from B's total", () => {
    const result = apportionToPrograms({ levelOfCareCosts: [], patientDays: [] });
    expect(programToWorksheetD(result, 500_000).tiesToWorksheetBTotal).toBe(false);
  });
});

describe("settlementToWorksheetE1", () => {
  it("maps the Medicare settlement (cap + sequestration) to a schema-valid E-1", () => {
    const input = {
      medicareAllowableCostCents: 4_000_000,
      interimPaymentsCents: 3_500_000,
      sequestrationRateMicros: 20_000, // 2%
      aggregateCap: { capYear: 2026, medicareBeneficiaryCount: 0, aggregateCapAmountCents: 5_000_000, totalMedicarePaymentsCents: 5_750_000 },
      inpatientCap: { capYear: 2026, totalMedicareDays: 1_000, inpatientDays: 120, inpatientCapPercent: 20, inpatientPaymentsCents: 0 },
    };
    const result = computeSettlement(input);
    const e1 = settlementToWorksheetE1(result, input);
    expect(Value.Check(WorksheetE1, e1)).toBe(true);
    expect(e1.medicare.allowablePaymentCents).toBe(4_000_000);
    expect(e1.medicare.interimPaymentsReceivedCents).toBe(3_500_000);
    expect(e1.medicare.capOverpaymentCents).toBe(750_000); // 5_750_000 − 5_000_000
    expect(e1.medicare.sequestrationAdjustmentCents).toBe(80_000); // 2% × 4_000_000
    expect(e1.medicare.balanceDueProviderCents).toBe(result.balanceDueToProviderCents);
    expect(e1.totalBalanceDueProviderCents).toBe(result.balanceDueToProviderCents);
    // Single-program report: Medicaid column zeroed; S-summary tie not yet computed.
    expect(e1.medicaid.balanceDueProviderCents).toBe(0);
    expect(e1.tiesToWorksheetSSettlementSummary).toBe(false);
  });
});

describe("allocationResultsToWorksheets — full chain from assembled inputs", () => {
  it("produces all four schema-valid derived payloads, B-total threading D's tie", () => {
    const inputs = assembleAllocationInputs(
      raw({
        worksheets: [
          { worksheetCode: "A", data: { costCenters: [{ code: "D1", name: "Nursing", totalCostsCents: 500_000 }] } },
          { worksheetCode: "C", data: { ancillaryCostCenters: [{ code: "ANC1", name: "PT", fullyAllocatedCostCents: 80_000, totalChargesCents: 100_000, medicareChargesCents: 60_000 }] } },
          { worksheetCode: "E-1", data: { medicare: { allowablePaymentCents: 4_000_000, interimPaymentsReceivedCents: 3_500_000 } } },
        ],
        monthlyBreakdown: { "2026-01": { rhc: { medicare: { patientDays: 30 } } } },
        cap: { capContext: CAP },
      }),
    );
    const payloads = allocationResultsToWorksheets({
      stepDown: stepDownAllocate(inputs.stepDown),
      ancillary: apportionAncillary(inputs.ancillary),
      program: apportionToPrograms(inputs.program),
      settlement: computeSettlement(inputs.settlement),
      settlementInput: inputs.settlement,
    });
    expect(Value.Check(WorksheetB, payloads.B)).toBe(true);
    expect(Value.Check(WorksheetC, payloads.C)).toBe(true);
    expect(Value.Check(WorksheetD, payloads.D)).toBe(true);
    expect(Value.Check(WorksheetE1, payloads["E-1"])).toBe(true);
    expect(payloads.B.totalFullyAllocatedCostCents).toBe(500_000);
    // The per-LOC split apportions B's full 500_000 by the census day mix → D ties B exactly.
    expect(payloads.D.tiesToWorksheetBTotal).toBe(true);
    expect(payloads.D.grandTotalApportionedCostCents).toBe(500_000);
    expect(payloads.D.medicare.rhcCostCents).toBe(500_000); // all days are rhc/medicare
    expect(payloads["E-1"].medicare.capOverpaymentCents).toBe(750_000);
  });
});
