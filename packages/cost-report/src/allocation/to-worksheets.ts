import type { WorksheetBData } from "../worksheets/b";
import type { WorksheetCData } from "../worksheets/c";
// @chartwarden/cost-report — the PURE allocation-RESULT → derived-worksheet mapper (Form CMS-1984-14, D8). The
// inverse of `assemble-inputs`: it turns the chain RESULTS (`StepDownAllocateResult` → Worksheet B,
// `PerDiemResult` → Worksheet C) into the TypeBox-typed `data` jsonb the `cost_report_worksheet` rows persist,
// so a `cost-allocation-recompute` materializes the derived worksheets. Total, deterministic functions over
// already-computed results — no DB, no clock, no recomputation. Money is INTEGER CENTS; no PHI (D18).
import type { AllocationColumnConfig, LocDays } from "./assemble-inputs";
import type { LevelOfCare, PerDiemInput, PerDiemResult } from "./per-diem";
import type { StepDownAllocateResult } from "./step-down";

/** The derived-worksheet `data` payloads a recompute materializes, keyed by worksheet code. */
export interface DerivedWorksheetPayloads {
  readonly B: WorksheetBData;
  readonly C: WorksheetCData;
}

/** The uppercase step-down cost-center code for each level of care (mirrors `assemble-inputs`). */
const LOC_CENTER_CODE: Record<LevelOfCare, string> = {
  chc: "CHC",
  rhc: "RHC",
  irc: "IRC",
  gip: "GIP",
};

/** `StepDownAllocateResult` → Worksheet B. The persisted `costCenters` are the four DIRECT level-of-care
 *  centers (each overhead center steps to zero and folds into them). `allocationColumns` records each overhead
 *  step's allocated pool (the basis itself lives on Worksheet B-1). */
export function stepDownToWorksheetB(
  result: StepDownAllocateResult,
  columns: readonly AllocationColumnConfig[],
): WorksheetBData {
  const poolByAllocator = new Map(
    result.steps.map((s) => [s.allocatingCenterCode, s.amountAllocatedCents]),
  );
  return {
    allocationColumns: columns.map((col) => ({
      generalServiceCostCenterCode: col.generalServiceCostCenterCode,
      allocationBasis: col.allocationBasis,
      poolAmountCents: poolByAllocator.get(col.generalServiceCostCenterCode) ?? 0,
    })),
    costCenters: result.centers
      .filter((c) => !c.isOverhead)
      .map((c) => ({
        code: c.code,
        name: c.name,
        directCostCents: c.directCostCents,
        allocatedOverheadCents: c.allocatedInCents,
        fullyAllocatedCostCents: c.totalCostCents,
      })),
    totalFullyAllocatedCostCents: result.totalAllocatedToDirectCents,
    tiesToWorksheetAGrandTotal: result.tiesOut,
    stepDownPreservesTotalExactly: result.tiesOut,
  };
}

/** Build the Worksheet C per-diem input from the step-down result (the four LOC centers' fully-allocated cost)
 *  + the per-LOC unduplicated days. The LOC cost is `totalCostCents` from B col. 18 (§4330). */
export function buildPerDiemInput(result: StepDownAllocateResult, locDays: LocDays): PerDiemInput {
  const costByCode = new Map(result.centers.map((c) => [c.code, c.totalCostCents]));
  return {
    levels: (Object.keys(LOC_CENTER_CODE) as LevelOfCare[]).map((loc) => ({
      levelOfCare: loc,
      totalCostCents: costByCode.get(LOC_CENTER_CODE[loc]) ?? 0,
      totalDays: locDays[loc].totalDays,
      medicareDays: locDays[loc].medicareDays,
      medicaidDays: locDays[loc].medicaidDays,
    })),
  };
}

/** `PerDiemResult` → Worksheet C. Maps each level's per-diem block; ties to B when Σ LOC cost equals B total. */
export function perDiemToWorksheetC(
  result: PerDiemResult,
  bTotalFullyAllocatedCostCents: number,
): WorksheetCData {
  const lvl = (loc: LevelOfCare) => {
    const r = result.levels.find((l) => l.levelOfCare === loc);
    return {
      totalCostCents: r?.totalCostCents ?? 0,
      totalDays: r?.totalDays ?? 0,
      averageCostPerDiem: r?.averageCostPerDiem ?? "0",
      medicareDays: r?.medicareDays ?? 0,
      medicareCostCents: r?.medicareCostCents ?? 0,
      medicaidDays: r?.medicaidDays ?? 0,
      medicaidCostCents: r?.medicaidCostCents ?? 0,
    };
  };
  return {
    continuousHomeCare: lvl("chc"),
    routineHomeCare: lvl("rhc"),
    inpatientRespiteCare: lvl("irc"),
    generalInpatientCare: lvl("gip"),
    totalHospiceCostCents: result.totalCostCents,
    totalHospiceDays: result.totalDays,
    totalAverageCostPerDiem: result.totalAverageCostPerDiem,
    tiesToWorksheetBTotal: result.totalCostCents === bTotalFullyAllocatedCostCents,
  };
}

/** Map a full chain run (B → C) to its derived-worksheet payloads. `stepDownColumns` is the user's Worksheet
 *  B-1 config echoed onto Worksheet B's allocation columns. */
export function allocationResultsToWorksheets(input: {
  readonly stepDown: StepDownAllocateResult;
  readonly perDiem: PerDiemResult;
  readonly stepDownColumns: readonly AllocationColumnConfig[];
}): DerivedWorksheetPayloads {
  const B = stepDownToWorksheetB(input.stepDown, input.stepDownColumns);
  return { B, C: perDiemToWorksheetC(input.perDiem, B.totalFullyAllocatedCostCents) };
}
