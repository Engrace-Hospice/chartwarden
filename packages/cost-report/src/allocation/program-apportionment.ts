// @wardenx/cost-report — M27 Worksheet D PROGRAM apportionment (§1.1, §4.4 M23 PatientDaysProvider, D8).
// The third hop of the propagation chain (A → B → C → D → E-1): the allowable cost per level of care
// (RHC / CHC / IRC / GIP, from Worksheets B/C) is apportioned to programs (Medicare / Medicaid / other)
// across months by PATIENT DAYS. Each level-of-care cost is split across its (program × month) day cells
// penny-true (largest-remainder) so the apportioned cost ties to the level-of-care cost to the cent. The
// per-diem cost per level of care is carried out as an exact decimal string (never a float) for audit.
//
// PURE DOMAIN, deterministic total function over an already-fetched input: no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`. Money is INTEGER CENTS at the boundary. Patient days are
// AGGREGATE counts by (program × level-of-care × month) — never patient-identifiable (D18).
import { allocateProportional, fromDecimal, ratio, toDecimal } from "../domain/money";
import type { Cents } from "../domain/money";
import { COST_REPORT_PROGRAMS } from "./ancillary-apportionment";
import type { CostReportProgram } from "./ancillary-apportionment";

/** The four hospice levels of care (42 CFR §418.302). Apportionment and the per-diem are per level. */
export type LevelOfCare = "rhc" | "chc" | "irc" | "gip";

/** Deterministic level-of-care ordering for output rows. */
export const LEVELS_OF_CARE: readonly LevelOfCare[] = ["rhc", "chc", "irc", "gip"] as const;

/** The allowable cost to apportion for one level of care (from the Worksheet B/C rollup). */
export interface LevelOfCareCostInput {
  readonly levelOfCare: LevelOfCare;
  readonly allowableCostCents: Cents;
}

/** One aggregate patient-day cell: days delivered at a level of care for a program in a month. */
export interface PatientDayCell {
  readonly levelOfCare: LevelOfCare;
  readonly program: CostReportProgram;
  /** Calendar month, `YYYY-MM`. Used only to bucket and order; never patient-identifiable. */
  readonly month: string;
  readonly patientDays: number;
}

/** The fully-fetched Worksheet D input. */
export interface ProgramApportionInput {
  readonly levelOfCareCosts: readonly LevelOfCareCostInput[];
  readonly patientDays: readonly PatientDayCell[];
}

/** One apportioned (level × program × month) cost cell. */
export interface ApportionedCostCell {
  readonly levelOfCare: LevelOfCare;
  readonly program: CostReportProgram;
  readonly month: string;
  readonly patientDays: number;
  readonly apportionedCostCents: Cents;
}

/** Per-level rollup: total cost, total days, and the exact per-diem cost as a decimal string. */
export interface LevelOfCareApportionment {
  readonly levelOfCare: LevelOfCare;
  readonly allowableCostCents: Cents;
  readonly totalPatientDays: number;
  /** Allowable cost ÷ total patient days, as an exact decimal string; "0" when there are no days. */
  readonly perDiemCostCents: string;
}

/** The Worksheet D result: per-cell apportionment, per-level rollups, and per-program totals. */
export interface ProgramApportionResult {
  readonly cells: readonly ApportionedCostCell[];
  readonly levels: readonly LevelOfCareApportionment[];
  readonly programTotals: ReadonlyArray<{ readonly program: CostReportProgram; readonly apportionedCostCents: Cents }>;
}

/** Stable comparator for day cells within a level: month ascending, then canonical program order. */
function compareCells(a: PatientDayCell, b: PatientDayCell): number {
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  return COST_REPORT_PROGRAMS.indexOf(a.program) - COST_REPORT_PROGRAMS.indexOf(b.program);
}

/**
 * Apportion each level-of-care allowable cost across its (program × month) patient-day cells. Within a
 * level the cells are sorted deterministically (month, then program) and the cost is split by day counts
 * with `allocateProportional`, so the apportioned cost ties to the level cost to the cent. A level with
 * zero patient days apportions zero to its (zero) cells and reports a "0" per-diem (no division). The
 * per-program totals roll the cells up in `COST_REPORT_PROGRAMS` order.
 *
 * CMS-CERT (see audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md): the precise Worksheet D column geometry
 * (program × level-of-care) and any CMS-prescribed rounding of the per-diem before re-multiplication are
 * PENDING confirmation against CMS Pub 15-2 Ch.43 (Form CMS-1984-14) — CMS publishes no penny-level worked
 * example, so this is verified internally (per-cell tie-out) but not yet line-certified against the form.
 */
export function apportionToPrograms(input: ProgramApportionInput): ProgramApportionResult {
  const cells: ApportionedCostCell[] = [];
  const levels: LevelOfCareApportionment[] = [];
  const programTotalMap = new Map<CostReportProgram, Cents>();
  for (const p of COST_REPORT_PROGRAMS) programTotalMap.set(p, 0);

  const costByLevel = new Map<LevelOfCare, Cents>();
  for (const lc of input.levelOfCareCosts) {
    costByLevel.set(lc.levelOfCare, (costByLevel.get(lc.levelOfCare) ?? 0) + lc.allowableCostCents);
  }

  for (const level of LEVELS_OF_CARE) {
    const allowableCostCents = costByLevel.get(level) ?? 0;
    const levelCells = input.patientDays.filter((c) => c.levelOfCare === level).slice().sort(compareCells);
    const totalPatientDays = levelCells.reduce((acc, c) => acc + c.patientDays, 0);

    const weights = levelCells.map((c) => c.patientDays);
    const parts = allocateProportional(allowableCostCents, weights);
    for (let i = 0; i < levelCells.length; i++) {
      const cell = levelCells[i]!;
      const apportionedCostCents = parts[i]!;
      cells.push({
        levelOfCare: cell.levelOfCare,
        program: cell.program,
        month: cell.month,
        patientDays: cell.patientDays,
        apportionedCostCents,
      });
      programTotalMap.set(cell.program, (programTotalMap.get(cell.program) ?? 0) + apportionedCostCents);
    }

    levels.push({
      levelOfCare: level,
      allowableCostCents,
      totalPatientDays,
      perDiemCostCents: totalPatientDays === 0 ? "0" : ratio(allowableCostCents, totalPatientDays).toString(),
    });
  }

  const programTotals = COST_REPORT_PROGRAMS.map((program) => ({
    program,
    apportionedCostCents: programTotalMap.get(program) ?? 0,
  }));

  return { cells, levels, programTotals };
}

/** Apply an exact decimal-string per-diem to a day count, rounded to whole cents via the money kernel. */
export function perDiemTimesDays(perDiemCents: string, days: number): Cents {
  return fromDecimal(toDecimal(0).plus(perDiemCents).times(days));
}
