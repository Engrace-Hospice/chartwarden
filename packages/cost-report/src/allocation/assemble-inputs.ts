// @wardenx/cost-report — the PURE allocation-input assembler (§3.1 `allocation/`, D8). Composes M27's
// already-read DB state (the materialized per-worksheet `data` jsonb of A / B / C / D / E-1, the
// `statistic_data` monthly census, and the resolved M26 cap context) into the FOUR typed inputs the
// deterministic propagation chain consumes — `StepDownAllocateInput` (Worksheet B), `AncillaryApportionInput`
// (C), `ProgramApportionInput` (D), and `SettlementInput` (E-1). No DB, no clock, no `getSeam`: the live
// builder reads + resolves, this function only shapes.
//
// Reads the jsonb DEFENSIVELY — every field optional, every absence a CONSERVATIVE default — so an incomplete
// report shapes into a TRIVIALLY-tie-out input (a no-op step-down, zero-cost apportionment) rather than a
// throw, and NOTHING is fabricated:
//   • Step-down statistical-basis WEIGHTS are not yet modeled in the persisted state (Worksheet B records the
//     allocation RESULT, not the per-receiving-center weights), so with no weights every Worksheet-A center is
//     emitted as DIRECT (isOverhead:false) and `statisticalBases` is empty → the step-down preserves each
//     center's direct cost exactly and ties out. Overhead step-down lights up when the weight model lands.
//   • Per-level-of-care allowable COST is split deterministically by the census PATIENT-DAY mix: the fully-
//     allocated total (= the Worksheet-A grand total, which the step-down conserves into B) is apportioned
//     across the four levels of care by their patient days via the penny-true allocator, so the downstream
//     program apportionment carries the whole B total and Worksheet D ties to B exactly. With no census
//     (no day basis) the split is empty (no fabricated basis) — D then legitimately does not tie B.
//   • The cap settlement lines appear ONLY when the M26 cap context is bound (else `capPositionPending`).
// Money is INTEGER CENTS. No PHI — aggregate cost/day mix only (D18).
import { type Cents, allocateProportional } from "../domain/money";
import type { CapContext } from "../validation/types";
import {
  type AncillaryApportionInput,
  type CostReportProgram,
  COST_REPORT_PROGRAMS,
} from "./ancillary-apportionment";
import {
  type LevelOfCare,
  type LevelOfCareCostInput,
  type PatientDayCell,
  type ProgramApportionInput,
  LEVELS_OF_CARE,
} from "./program-apportionment";
import type { SettlementInput } from "./settlement";
import type { StatisticalBasis, StepDownAllocateInput, StepDownCostCenter } from "./step-down";

/** One already-read `cost_report_worksheet` row: its code + untyped `data` jsonb. */
export interface RawAllocationWorksheet {
  readonly worksheetCode: string;
  readonly data: unknown;
}

/** The Worksheet-B step-down CONFIG read from the persisted `allocationColumns` input (which overhead centers
 *  allocate, the basis label, and the per-receiving-center statistical weights). Carried forward on
 *  {@link AllocationInputs} so the recompute PRESERVES it when it writes the derived Worksheet B back. */
export interface AllocationColumnConfig {
  readonly generalServiceCostCenterCode: string;
  readonly allocationBasis: string;
  readonly statisticalWeights: readonly { readonly receivingCenterCode: string; readonly statisticValue: number }[];
}

/** The raw, already-read DB facts the four allocation inputs are shaped from. */
export interface RawAllocationInputs {
  /** The federal cap year (= the FYE year) the settlement cap lines are pinned to. */
  readonly fiscalYearInt: number;
  readonly worksheets: readonly RawAllocationWorksheet[];
  /** `statistic_data.monthly_breakdown` — { [month]: { [loc]: { [program]: { patientDays } } } }; null = unrefreshed. */
  readonly monthlyBreakdown: unknown | null;
  /** The M26 cap context (resolved via the cap seam); null when M26 is unbound → cap lines SKIP. */
  readonly cap: { readonly capContext: CapContext | null };
}

/** The four typed allocation inputs the recompute chain runs over, plus the step-down column config carried
 *  forward so the write-back preserves the user's Worksheet-B `allocationColumns`. */
export interface AllocationInputs {
  readonly stepDown: StepDownAllocateInput;
  readonly ancillary: AncillaryApportionInput;
  readonly program: ProgramApportionInput;
  readonly settlement: SettlementInput;
  readonly stepDownColumns: readonly AllocationColumnConfig[];
}

/** 42 CFR §418.302(f): inpatient days (GIP + IRC) are limited to 20% of total Medicare days. TODO(CMS-fixture):
 *  confirm the per-FY percentage and the day-set (GIP only vs GIP+IRC) against a CMS-published Worksheet E-1. */
const INPATIENT_DAY_CAP_PERCENT = 20;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const LEVEL_SET = new Set<string>(LEVELS_OF_CARE);
const PROGRAM_SET = new Set<string>(COST_REPORT_PROGRAMS);

/** Shape the four allocation inputs from the read DB state. Defensive: every absence → a conservative,
 *  tie-out-safe default; nothing fabricated. */
export function assembleAllocationInputs(input: RawAllocationInputs): AllocationInputs {
  const byCode = new Map(input.worksheets.map((w) => [w.worksheetCode, w.data]));
  const ws = (code: string): Record<string, unknown> =>
    (byCode.get(code) as Record<string, unknown> | undefined) ?? {};

  const { stepDown, stepDownColumns } = assembleStepDown(ws("A"), ws("B"));
  // The fully-allocated total the step-down conserves into Worksheet B (= Σ direct costs from A). This is the
  // pool the program apportionment splits across levels of care, so Worksheet D's grand total ties to B.
  const allocatableTotalCents = stepDown.costCenters.reduce((s, c) => s + c.directCostCents, 0);

  return {
    stepDown,
    ancillary: assembleAncillary(ws("C")),
    program: assembleProgram(input.monthlyBreakdown, allocatableTotalCents),
    settlement: assembleSettlement(ws("E-1"), ws("D"), input.cap.capContext, input.fiscalYearInt),
    stepDownColumns,
  };
}

/** Worksheets A + B → step-down input. Worksheet A supplies the cost centers + their direct costs (in
 *  allocation order); Worksheet B's `allocationColumns` config supplies WHICH centers are overhead and the
 *  per-receiving-center statistical weights that drive each overhead pool's step-down. With no B config every
 *  center is DIRECT and the bases are empty → the step-down preserves each center's direct cost exactly (a
 *  no-op pass that still ties out). The parsed columns are returned so the write-back can preserve them. */
function assembleStepDown(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): { stepDown: StepDownAllocateInput; stepDownColumns: AllocationColumnConfig[] } {
  const rawColumns = Array.isArray(b.allocationColumns) ? (b.allocationColumns as Record<string, unknown>[]) : [];
  const stepDownColumns: AllocationColumnConfig[] = rawColumns
    .filter((col) => str(col.generalServiceCostCenterCode).length > 0)
    .map((col) => ({
      generalServiceCostCenterCode: str(col.generalServiceCostCenterCode),
      allocationBasis: str(col.allocationBasis),
      statisticalWeights: (Array.isArray(col.statisticalWeights) ? (col.statisticalWeights as Record<string, unknown>[]) : [])
        .map((w) => ({ receivingCenterCode: str(w.receivingCenterCode), statisticValue: num(w.statisticValue) }))
        .filter((w) => w.receivingCenterCode.length > 0),
    }));

  const overheadCodes = new Set(stepDownColumns.map((c) => c.generalServiceCostCenterCode));
  const aCenters = Array.isArray(a.costCenters) ? (a.costCenters as Record<string, unknown>[]) : [];
  const costCenters: StepDownCostCenter[] = aCenters.map((cc) => ({
    code: str(cc.code),
    name: str(cc.name),
    directCostCents: num(cc.totalCostsCents),
    isOverhead: overheadCodes.has(str(cc.code)),
  }));

  const statisticalBases: StatisticalBasis[] = stepDownColumns.map((col) => ({
    allocatingCenterCode: col.generalServiceCostCenterCode,
    weights: col.statisticalWeights.map((w) => ({ receivingCenterCode: w.receivingCenterCode, statisticValue: w.statisticValue })),
  }));

  return { stepDown: { costCenters, statisticalBases }, stepDownColumns };
}

/** Worksheet C → ancillary RCC inputs. C models Medicare charges only today, so each center's `programCharges`
 *  carries the Medicare line; an absent C yields no centers. */
function assembleAncillary(c: Record<string, unknown>): AncillaryApportionInput {
  const cCenters = Array.isArray(c.ancillaryCostCenters) ? (c.ancillaryCostCenters as Record<string, unknown>[]) : [];
  return {
    costCenters: cCenters.map((cc) => ({
      code: str(cc.code),
      name: str(cc.name),
      totalCostCents: num(cc.fullyAllocatedCostCents),
      totalChargesCents: num(cc.totalChargesCents),
      programCharges: [{ program: "medicare" as CostReportProgram, chargesCents: num(cc.medicareChargesCents) }],
    })),
  };
}

/** `statistic_data.monthly_breakdown` → the Worksheet D patient-day cells + the per-LOC allowable-cost split.
 *  The fully-allocated total (`allocatableTotalCents`, = the conserved Worksheet-B total) is apportioned across
 *  the levels of care by their patient-day mix via the penny-true allocator, so the per-LOC costs sum EXACTLY
 *  to B and the downstream program apportionment carries the whole total → Worksheet D ties to B. An LOC earns
 *  cost only in proportion to its days (a zero-day LOC gets zero, so its cost never strands a cell-less level),
 *  and with no census at all (no day basis) the split is empty — no fabricated basis. Unknown LOC / program
 *  keys are dropped (never coerced). */
function assembleProgram(monthlyBreakdown: unknown | null, allocatableTotalCents: number): ProgramApportionInput {
  const patientDays: PatientDayCell[] = [];
  const daysByLevel = new Map<LevelOfCare, number>();
  const months = (monthlyBreakdown ?? {}) as Record<
    string,
    Record<string, Record<string, { patientDays?: unknown }>>
  >;
  for (const [month, locs] of Object.entries(months ?? {})) {
    for (const [locKey, programs] of Object.entries(locs ?? {})) {
      const loc = locKey.toLowerCase();
      if (!LEVEL_SET.has(loc)) continue;
      for (const [progKey, cell] of Object.entries(programs ?? {})) {
        const program = progKey.toLowerCase();
        if (!PROGRAM_SET.has(program)) continue;
        const days = num((cell as { patientDays?: unknown })?.patientDays);
        patientDays.push({ levelOfCare: loc as LevelOfCare, program: program as CostReportProgram, month, patientDays: days });
        daysByLevel.set(loc as LevelOfCare, (daysByLevel.get(loc as LevelOfCare) ?? 0) + days);
      }
    }
  }

  // Split the fully-allocated total across LOCs by their day mix (penny-true → sums to the total exactly).
  // Skip when there is no cost or no day basis (an incomplete report → D legitimately does not tie B).
  const totalDays = LEVELS_OF_CARE.reduce((s, l) => s + (daysByLevel.get(l) ?? 0), 0);
  let levelOfCareCosts: LevelOfCareCostInput[] = [];
  if (allocatableTotalCents > 0 && totalDays > 0) {
    const weights = LEVELS_OF_CARE.map((l) => daysByLevel.get(l) ?? 0);
    const parts = allocateProportional(allocatableTotalCents, weights);
    levelOfCareCosts = LEVELS_OF_CARE.map((levelOfCare, i) => ({ levelOfCare, allowableCostCents: parts[i]! }));
  }
  return { levelOfCareCosts, patientDays };
}

/** Worksheets E-1 / D + the M26 cap context → the settlement input. Allowable cost / interim payments are read
 *  from the persisted E-1 Medicare line (falling back to D's Medicare total). The aggregate + inpatient cap
 *  inputs are supplied ONLY when M26 is bound (else both are omitted → `capPositionPending`, cap math skipped).
 *  SIA and the per-FY sequestration rate are not yet modeled → omitted (zero). */
function assembleSettlement(
  e1: Record<string, unknown>,
  d: Record<string, unknown>,
  cap: CapContext | null,
  fiscalYearInt: number,
): SettlementInput {
  const e1Medicare = (e1.medicare as Record<string, unknown> | undefined) ?? {};
  const dMedicare = (d.medicare as Record<string, unknown> | undefined) ?? {};

  const allowableFromE1 = num(e1Medicare.allowablePaymentCents);
  const medicareAllowableCostCents: Cents = allowableFromE1 !== 0 ? allowableFromE1 : num(dMedicare.totalCostCents);
  const interimPaymentsCents: Cents = num(e1Medicare.interimPaymentsReceivedCents);

  const base: SettlementInput = { medicareAllowableCostCents, interimPaymentsCents };
  if (!cap) return base;

  return {
    ...base,
    aggregateCap: {
      capYear: fiscalYearInt,
      // medicareBeneficiaryCount is unused by the settlement math (the cap $ is supplied directly by M26).
      medicareBeneficiaryCount: 0,
      aggregateCapAmountCents: cap.aggregateCapCents,
      totalMedicarePaymentsCents: cap.aggregatePaymentsCents,
    },
    inpatientCap: {
      capYear: fiscalYearInt,
      totalMedicareDays: cap.totalMedicareDays,
      inpatientDays: cap.inpatientDays,
      inpatientCapPercent: INPATIENT_DAY_CAP_PERCENT,
      // The inpatient-payment ceiling/reduction is not yet sourced → 0 (the day-cap POSITION is still reported).
      inpatientPaymentsCents: 0,
    },
  };
}
