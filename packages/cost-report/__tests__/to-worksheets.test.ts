// @wardenx/cost-report — PURE allocation-RESULT → derived-worksheet mapper unit suite (Form CMS-1984-14).
// Asserts the inverse of `assemble-inputs`: the chain results map to the TypeBox-typed B/C `data` payloads a
// recompute persists, the tie flags are stamped, and each payload validates against its worksheet schema.
import { Value } from "@sinclair/typebox/value";
import {
  type RawAllocationInputs,
  WorksheetB,
  WorksheetC,
  allocationResultsToWorksheets,
  assembleAllocationInputs,
  buildPerDiemInput,
  calculatePerDiem,
  perDiemToWorksheetC,
  stepDownAllocate,
  stepDownToWorksheetB,
} from "@wardenx/cost-report";
import { describe, expect, it } from "vitest";

function raw(over: Partial<RawAllocationInputs> = {}): RawAllocationInputs {
  return { worksheets: [], monthlyBreakdown: null, ...over };
}

describe("stepDownToWorksheetB", () => {
  it("persists the LOC direct centers + preserves the B-1 column config, schema-valid", () => {
    const result = stepDownAllocate({
      costCenters: [
        { code: "AG", name: "A&G", directCostCents: 100_000, isOverhead: true },
        { code: "RHC", name: "Routine Home Care", directCostCents: 300_000, isOverhead: false },
      ],
      statisticalBases: [
        {
          allocatingCenterCode: "AG",
          weights: [{ receivingCenterCode: "RHC", statisticValue: 1 }],
        },
      ],
    });
    const b = stepDownToWorksheetB(result, [
      {
        generalServiceCostCenterCode: "AG",
        allocationBasis: "square_feet",
        statisticalWeights: [],
      },
    ]);
    expect(Value.Check(WorksheetB, b)).toBe(true);
    expect(b.totalFullyAllocatedCostCents).toBe(400_000);
    expect(b.tiesToWorksheetAGrandTotal).toBe(true);
    expect(b.costCenters.map((c) => c.code)).toEqual(["RHC"]); // overhead folded out
    expect(b.allocationColumns).toEqual([
      {
        generalServiceCostCenterCode: "AG",
        allocationBasis: "square_feet",
        poolAmountCents: 100_000,
      },
    ]);
  });
});

describe("perDiemToWorksheetC", () => {
  it("maps each level's per-diem block and stamps the B tie, schema-valid", () => {
    const perDiem = calculatePerDiem({
      levels: [
        { levelOfCare: "chc", totalCostCents: 0, totalDays: 0, medicareDays: 0, medicaidDays: 0 },
        {
          levelOfCare: "rhc",
          totalCostCents: 300_000,
          totalDays: 100,
          medicareDays: 60,
          medicaidDays: 40,
        },
        { levelOfCare: "irc", totalCostCents: 0, totalDays: 0, medicareDays: 0, medicaidDays: 0 },
        {
          levelOfCare: "gip",
          totalCostCents: 100_000,
          totalDays: 10,
          medicareDays: 8,
          medicaidDays: 0,
        },
      ],
    });
    const c = perDiemToWorksheetC(perDiem, 400_000);
    expect(Value.Check(WorksheetC, c)).toBe(true);
    expect(c.routineHomeCare.medicareCostCents).toBe(180_000); // 3000 × 60
    expect(c.totalHospiceCostCents).toBe(400_000);
    expect(c.tiesToWorksheetBTotal).toBe(true);
  });

  it("does NOT tie when Σ level cost differs from the B total", () => {
    const perDiem = calculatePerDiem({ levels: [] });
    expect(perDiemToWorksheetC(perDiem, 500_000).tiesToWorksheetBTotal).toBe(false);
  });
});

describe("allocationResultsToWorksheets — full chain from assembled inputs", () => {
  it("produces schema-valid B + C, with C tying B", () => {
    const inputs = assembleAllocationInputs(
      raw({
        worksheets: [{ worksheetCode: "A-2", data: { netDirectCostCents: 500_000 } }],
        monthlyBreakdown: { "2026-01": { rhc: { medicare: { patientDays: 100 } } } },
      }),
    );
    const step = stepDownAllocate(inputs.stepDown);
    const perDiem = calculatePerDiem(buildPerDiemInput(step, inputs.locDays));
    const payloads = allocationResultsToWorksheets({
      stepDown: step,
      perDiem,
      stepDownColumns: inputs.stepDownColumns,
    });
    expect(Value.Check(WorksheetB, payloads.B)).toBe(true);
    expect(Value.Check(WorksheetC, payloads.C)).toBe(true);
    expect(payloads.B.totalFullyAllocatedCostCents).toBe(500_000);
    expect(payloads.C.tiesToWorksheetBTotal).toBe(true);
    expect(payloads.C.routineHomeCare.medicareCostCents).toBe(500_000); // all days rhc/medicare
  });
});
