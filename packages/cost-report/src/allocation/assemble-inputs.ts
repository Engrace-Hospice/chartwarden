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
//   • Per-level-of-care allowable COST is not yet split by LOC upstream, so `levelOfCareCosts` is empty → the
//     program apportionment carries the (real, materialized) patient-day cells at zero apportioned cost.
//   • The cap settlement lines appear ONLY when the M26 cap context is bound (else `capPositionPending`).
// Money is INTEGER CENTS. No PHI — aggregate cost/day mix only (D18).
import type { Cents } from "../domain/money";
import type { CapContext } from "../validation/types";
import {
  type AncillaryApportionInput,
  type CostReportProgram,
  COST_REPORT_PROGRAMS,
} from "./ancillary-apportionment";
import {
  type LevelOfCare,
  type PatientDayCell,
  type ProgramApportionInput,
  LEVELS_OF_CARE,
} from "./program-apportionment";
import type { SettlementInput } from "./settlement";
import type { StepDownAllocateInput, StepDownCostCenter } from "./step-down";

/** One already-read `cost_report_worksheet` row: its code + untyped `data` jsonb. */
export interface RawAllocationWorksheet {
  readonly worksheetCode: string;
  readonly data: unknown;
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

/** The four typed allocation inputs the recompute chain runs over. */
export interface AllocationInputs {
  readonly stepDown: StepDownAllocateInput;
  readonly ancillary: AncillaryApportionInput;
  readonly program: ProgramApportionInput;
  readonly settlement: SettlementInput;
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

  return {
    stepDown: assembleStepDown(ws("A")),
    ancillary: assembleAncillary(ws("C")),
    program: assembleProgram(input.monthlyBreakdown),
    settlement: assembleSettlement(ws("E-1"), ws("D"), input.cap.capContext, input.fiscalYearInt),
  };
}

/** Worksheet A → step-down cost centers. Every center is DIRECT and the statistical bases are empty until the
 *  per-receiving-center weight model lands (Worksheet B persists the result, not the weights) → the step-down
 *  preserves each center's direct cost exactly and ties out. */
function assembleStepDown(a: Record<string, unknown>): StepDownAllocateInput {
  const aCenters = Array.isArray(a.costCenters) ? (a.costCenters as Record<string, unknown>[]) : [];
  const costCenters: StepDownCostCenter[] = aCenters.map((cc) => ({
    code: str(cc.code),
    name: str(cc.name),
    directCostCents: num(cc.totalCostsCents),
    isOverhead: false,
  }));
  return { costCenters, statisticalBases: [] };
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

/** `statistic_data.monthly_breakdown` → the Worksheet D patient-day cells. Per-LOC allowable cost is not yet
 *  split upstream, so `levelOfCareCosts` is empty (the cells carry at zero apportioned cost). Unknown LOC /
 *  program keys are dropped (never coerced). */
function assembleProgram(monthlyBreakdown: unknown | null): ProgramApportionInput {
  const patientDays: PatientDayCell[] = [];
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
        patientDays.push({
          levelOfCare: loc as LevelOfCare,
          program: program as CostReportProgram,
          month,
          patientDays: num((cell as { patientDays?: unknown })?.patientDays),
        });
      }
    }
  }
  return { levelOfCareCosts: [], patientDays };
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
