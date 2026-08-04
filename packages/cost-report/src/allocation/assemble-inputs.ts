// @wardenx/cost-report — the PURE allocation-input assembler (Form CMS-1984-14, §4320/§4330, D8). Composes
// M27's already-read worksheet state into the inputs the deterministic hospice chain consumes:
//   • the Worksheet B step-down (`StepDownAllocateInput`): the general-service cost centers from Worksheet A
//     (overhead, in allocation order) plus the four direct level-of-care centers from Worksheets A-1…A-4
//     (CHC/RHC/IRC/GIP net direct cost), with the per-receiving-center statistical weights read from the
//     Worksheet B-1 statistical basis (§4320). All overhead steps down into the four LOC centers, so the
//     fully-allocated total ties to Worksheet A and flows entirely into the LOC centers (→ Worksheet C ties B).
//   • the per-LOC day counts (`LocDays`) for Worksheet C: total / Medicare / Medicaid unduplicated days per
//     level of care (§4330 sources these from Worksheet S-1; here aggregated from the materialized census).
// No DB, no clock, no `getSeam`. Reads jsonb DEFENSIVELY (every absence → a conservative, tie-out-safe
// default; nothing fabricated). Money is INTEGER CENTS; no PHI — aggregate cost/day only (D18).
import { LEVELS_OF_CARE, type LevelOfCare } from "./per-diem";
import type { StatisticalBasis, StepDownAllocateInput, StepDownCostCenter } from "./step-down";

/** One already-read `cost_report_worksheet` row: its code + untyped `data` jsonb. */
export interface RawAllocationWorksheet {
  readonly worksheetCode: string;
  readonly data: unknown;
}

/** The Worksheet-B-1 step-down CONFIG read from the persisted statistical-basis columns (which overhead
 *  centers allocate, the basis label, and the per-receiving-center statistical weights). Carried forward on
 *  {@link AllocationInputs} so the recompute PRESERVES it when it writes Worksheet B back. */
export interface AllocationColumnConfig {
  readonly generalServiceCostCenterCode: string;
  readonly allocationBasis: string;
  readonly statisticalWeights: readonly {
    readonly receivingCenterCode: string;
    readonly statisticValue: number;
  }[];
}

/** Total / Medicare / Medicaid unduplicated days per level of care (feeds Worksheet C, §4330). */
export type LocDays = Record<
  LevelOfCare,
  { totalDays: number; medicareDays: number; medicaidDays: number }
>;

/** The raw, already-read worksheet state the allocation inputs are shaped from. */
export interface RawAllocationInputs {
  readonly worksheets: readonly RawAllocationWorksheet[];
  /** `statistic_data.monthly_breakdown` — { [month]: { [loc]: { [program]: { patientDays } } } }; null = unrefreshed. */
  readonly monthlyBreakdown: unknown | null;
}

/** The allocation inputs the recompute chain runs over, plus the B-1 column config carried forward so the
 *  write-back preserves the user's statistical basis. */
export interface AllocationInputs {
  readonly stepDown: StepDownAllocateInput;
  readonly locDays: LocDays;
  readonly stepDownColumns: readonly AllocationColumnConfig[];
}

/** The four LOC direct-care centers, sourced from Worksheets A-1…A-4 (§4320 col. 0: A-1→CHC line 50, A-2→RHC
 *  51, A-3→IRC 52, A-4→GIP 53). The cost-center code on the step-down is the uppercase LOC token. */
const LOC_FROM_WORKSHEET: ReadonlyArray<{
  code: string;
  ws: string;
  loc: LevelOfCare;
  name: string;
}> = [
  { code: "CHC", ws: "A-1", loc: "chc", name: "Continuous Home Care" },
  { code: "RHC", ws: "A-2", loc: "rhc", name: "Routine Home Care" },
  { code: "IRC", ws: "A-3", loc: "irc", name: "Inpatient Respite Care" },
  { code: "GIP", ws: "A-4", loc: "gip", name: "General Inpatient Care" },
];

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const LEVEL_SET = new Set<string>(LEVELS_OF_CARE);

/** Shape the allocation inputs from the read worksheet state. Defensive: every absence → a tie-out-safe
 *  default; nothing fabricated. */
export function assembleAllocationInputs(input: RawAllocationInputs): AllocationInputs {
  const byCode = new Map(input.worksheets.map((w) => [w.worksheetCode, w.data]));
  const ws = (code: string): Record<string, unknown> =>
    (byCode.get(code) as Record<string, unknown> | undefined) ?? {};

  const { stepDown, stepDownColumns } = assembleStepDown(ws("A"), ws("B-1"), byCode);
  return { stepDown, stepDownColumns, locDays: assembleLocDays(input.monthlyBreakdown) };
}

/** Worksheets A + A-1…A-4 + B-1 → step-down input. Worksheet A supplies the general-service (overhead) cost
 *  centers (in allocation order); A-1…A-4 supply the four direct LOC centers; B-1 supplies the per-receiving
 *  statistical weights. ALL Worksheet-A centers are overhead (general service) that step down into the four
 *  LOC centers, so the fully-allocated total flows entirely into the LOC centers and Worksheet C ties B. With
 *  no B-1 config the pools spread by the allocator default; the parsed columns are returned for the write-back. */
function assembleStepDown(
  a: Record<string, unknown>,
  b1: Record<string, unknown>,
  byCode: ReadonlyMap<string, unknown>,
): { stepDown: StepDownAllocateInput; stepDownColumns: AllocationColumnConfig[] } {
  const rawColumns = Array.isArray(b1.columns) ? (b1.columns as Record<string, unknown>[]) : [];
  const stepDownColumns: AllocationColumnConfig[] = rawColumns
    .filter((col) => str(col.generalServiceCostCenterCode).length > 0)
    .map((col) => ({
      generalServiceCostCenterCode: str(col.generalServiceCostCenterCode),
      allocationBasis: str(col.allocationBasis),
      statisticalWeights: (Array.isArray(col.statisticalPortions)
        ? (col.statisticalPortions as Record<string, unknown>[])
        : []
      )
        .map((w) => ({
          receivingCenterCode: str(w.receivingCenterCode),
          statisticValue: num(w.statisticValue),
        }))
        .filter((w) => w.receivingCenterCode.length > 0),
    }));

  // General-service (overhead) centers from Worksheet A — every A cost center steps down to the LOC centers.
  const aCenters = Array.isArray(a.costCenters) ? (a.costCenters as Record<string, unknown>[]) : [];
  const overhead: StepDownCostCenter[] = aCenters.map((cc) => ({
    code: str(cc.code),
    name: str(cc.name),
    directCostCents: num(cc.totalCostsCents),
    isOverhead: true,
  }));

  // The four direct LOC centers from Worksheets A-1…A-4 (net direct cost, col. 7 line 100).
  const locCenters: StepDownCostCenter[] = LOC_FROM_WORKSHEET.map((m) => ({
    code: m.code,
    name: m.name,
    directCostCents: num(
      (byCode.get(m.ws) as Record<string, unknown> | undefined)?.netDirectCostCents,
    ),
    isOverhead: false,
  }));

  const statisticalBases: StatisticalBasis[] = stepDownColumns.map((col) => ({
    allocatingCenterCode: col.generalServiceCostCenterCode,
    weights: col.statisticalWeights.map((w) => ({
      receivingCenterCode: w.receivingCenterCode,
      statisticValue: w.statisticValue,
    })),
  }));

  return {
    stepDown: { costCenters: [...overhead, ...locCenters], statisticalBases },
    stepDownColumns,
  };
}

/** `statistic_data.monthly_breakdown` → per-LOC total/Medicare/Medicaid day counts for Worksheet C. Unknown
 *  LOC keys are dropped; total days count ALL programs at the level, the program lines only Medicare/Medicaid. */
function assembleLocDays(monthlyBreakdown: unknown | null): LocDays {
  const days: LocDays = {
    chc: { totalDays: 0, medicareDays: 0, medicaidDays: 0 },
    rhc: { totalDays: 0, medicareDays: 0, medicaidDays: 0 },
    irc: { totalDays: 0, medicareDays: 0, medicaidDays: 0 },
    gip: { totalDays: 0, medicareDays: 0, medicaidDays: 0 },
  };
  const months = (monthlyBreakdown ?? {}) as Record<
    string,
    Record<string, Record<string, { patientDays?: unknown }>>
  >;
  for (const locs of Object.values(months ?? {})) {
    for (const [locKey, programs] of Object.entries(locs ?? {})) {
      const loc = locKey.toLowerCase();
      if (!LEVEL_SET.has(loc)) continue;
      const cell = days[loc as LevelOfCare];
      for (const [progKey, c] of Object.entries(programs ?? {})) {
        const d = num((c as { patientDays?: unknown })?.patientDays);
        cell.totalDays += d;
        if (progKey.toLowerCase() === "medicare") cell.medicareDays += d;
        else if (progKey.toLowerCase() === "medicaid") cell.medicaidDays += d;
      }
    }
  }
  return days;
}
