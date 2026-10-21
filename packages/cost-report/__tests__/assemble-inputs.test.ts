import {
  type RawAllocationInputs,
  assembleAllocationInputs,
  buildPerDiemInput,
  calculatePerDiem,
  stepDownAllocate,
} from "@chartwarden/cost-report";
// @chartwarden/cost-report — PURE allocation-input assembler unit suite (Form CMS-1984-14 §4320/§4330). Asserts
// the worksheet → input shaping of `assembleAllocationInputs`: Worksheet A general-service centers + A-1…A-4
// LOC direct costs + the Worksheet B-1 statistical basis → the step-down input; the census → per-LOC days.
import { describe, expect, it } from "vitest";

function raw(over: Partial<RawAllocationInputs> = {}): RawAllocationInputs {
  return { worksheets: [], monthlyBreakdown: null, ...over };
}

describe("assembleAllocationInputs — step-down (A + A-1…A-4 + B-1)", () => {
  it("treats Worksheet-A centers as overhead and A-1…A-4 as the four LOC direct centers", () => {
    const inputs = assembleAllocationInputs(
      raw({
        worksheets: [
          {
            worksheetCode: "A",
            data: { costCenters: [{ code: "AG", name: "A&G", totalCostsCents: 100_000 }] },
          },
          { worksheetCode: "A-1", data: { netDirectCostCents: 50_000 } }, // CHC
          { worksheetCode: "A-2", data: { netDirectCostCents: 300_000 } }, // RHC
          { worksheetCode: "A-3", data: { netDirectCostCents: 20_000 } }, // IRC
          { worksheetCode: "A-4", data: { netDirectCostCents: 30_000 } }, // GIP
          {
            worksheetCode: "B-1",
            data: {
              columns: [
                {
                  generalServiceCostCenterCode: "AG",
                  allocationBasis: "accumulated_cost",
                  statisticalPortions: [
                    { receivingCenterCode: "RHC", statisticValue: 3 },
                    { receivingCenterCode: "CHC", statisticValue: 1 },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    const codes = inputs.stepDown.costCenters.map((c) => c.code);
    expect(codes).toEqual(["AG", "CHC", "RHC", "IRC", "GIP"]);
    expect(inputs.stepDown.costCenters.find((c) => c.code === "AG")!.isOverhead).toBe(true);
    expect(inputs.stepDown.costCenters.filter((c) => !c.isOverhead).map((c) => c.code)).toEqual([
      "CHC",
      "RHC",
      "IRC",
      "GIP",
    ]);
    expect(inputs.stepDown.statisticalBases[0]!.allocatingCenterCode).toBe("AG");
    expect(inputs.stepDownColumns[0]!.allocationBasis).toBe("accumulated_cost");

    // The step-down conserves the pool: Σ LOC fully-allocated = Σ all direct cost (overhead folds into LOC).
    const r = stepDownAllocate(inputs.stepDown);
    expect(r.tiesOut).toBe(true);
    expect(r.totalAllocatedToDirectCents).toBe(100_000 + 50_000 + 300_000 + 20_000 + 30_000);
  });

  it("absent worksheets → empty overhead + zero-cost LOC centers, trivial tie-out", () => {
    const inputs = assembleAllocationInputs(raw());
    expect(inputs.stepDown.costCenters.map((c) => c.code)).toEqual(["CHC", "RHC", "IRC", "GIP"]);
    expect(stepDownAllocate(inputs.stepDown).tiesOut).toBe(true);
  });
});

describe("assembleAllocationInputs — per-LOC days (Worksheet C)", () => {
  it("aggregates the census into total / Medicare / Medicaid days per level, dropping unknown LOCs", () => {
    const inputs = assembleAllocationInputs(
      raw({
        monthlyBreakdown: {
          "2026-01": {
            rhc: {
              medicare: { patientDays: 30 },
              medicaid: { patientDays: 5 },
              other: { patientDays: 2 },
            },
            gip: { medicare: { patientDays: 4 } },
            unknown_loc: { medicare: { patientDays: 99 } },
          },
          "2026-02": { rhc: { medicare: { patientDays: 28 } } },
        },
      }),
    );
    expect(inputs.locDays.rhc).toEqual({
      totalDays: 30 + 5 + 2 + 28,
      medicareDays: 58,
      medicaidDays: 5,
    });
    expect(inputs.locDays.gip).toEqual({ totalDays: 4, medicareDays: 4, medicaidDays: 0 });
    expect(inputs.locDays.chc).toEqual({ totalDays: 0, medicareDays: 0, medicaidDays: 0 });
  });
});

describe("assembleAllocationInputs — end-to-end A → B → C ties", () => {
  it("the per-diem Worksheet C total ties the step-down Worksheet B total exactly", () => {
    const inputs = assembleAllocationInputs(
      raw({
        worksheets: [
          { worksheetCode: "A-2", data: { netDirectCostCents: 600_000 } }, // RHC direct
        ],
        monthlyBreakdown: {
          "2026-01": { rhc: { medicare: { patientDays: 60 }, medicaid: { patientDays: 40 } } },
        },
      }),
    );
    const step = stepDownAllocate(inputs.stepDown);
    const perDiem = calculatePerDiem(buildPerDiemInput(step, inputs.locDays));
    expect(step.totalAllocatedToDirectCents).toBe(600_000);
    expect(perDiem.totalCostCents).toBe(600_000); // C ties B
    // 600_000 / 100 days = 6000 per diem → Medicare 60d = 360_000, Medicaid 40d = 240_000.
    const rhc = perDiem.levels.find((l) => l.levelOfCare === "rhc")!;
    expect(rhc.medicareCostCents).toBe(360_000);
    expect(rhc.medicaidCostCents).toBe(240_000);
  });
});
