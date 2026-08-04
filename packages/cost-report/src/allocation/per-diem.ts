// @wardenx/cost-report — M27 Worksheet C PER-DIEM COST calculation (Form CMS-1984-14, Pub 15-2 §4330, D8).
// The terminal hop of the hospice cost chain (A → B/B-1 step-down → C): for each level of care, the
// fully-allocated cost from Worksheet B (col. 18) is divided by the total *unduplicated* days to get the
// average cost per diem, which is then multiplied by the program (Medicare XVIII / Medicaid XIX) days to get
// the program cost. Per diem is carried as an EXACT decimal string (never a float) and program cost rounds
// HALF-UP to whole cents. There is no ancillary RCC and no settlement worksheet on the hospice form — this is
// the end of the cost computation.
//
// PURE DOMAIN, deterministic total function over an already-fetched input: no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`. Money is INTEGER CENTS; days are AGGREGATE counts (no PHI, D18).
import { type Cents, fromDecimal, ratio, sumCents, toDecimal } from "../domain/money";

/** The four hospice levels of care (Worksheet B lines 50–53 / Worksheet C blocks), in form order. */
export type LevelOfCare = "chc" | "rhc" | "irc" | "gip";
export const LEVELS_OF_CARE: readonly LevelOfCare[] = ["chc", "rhc", "irc", "gip"] as const;

/** One level of care's per-diem inputs: its fully-allocated cost (B col. 18) and its days (S-1 unduplicated). */
export interface PerDiemLevelInput {
  readonly levelOfCare: LevelOfCare;
  readonly totalCostCents: Cents;
  readonly totalDays: number;
  readonly medicareDays: number;
  readonly medicaidDays: number;
}

export interface PerDiemInput {
  readonly levels: readonly PerDiemLevelInput[];
}

export interface PerDiemLevelResult {
  readonly levelOfCare: LevelOfCare;
  readonly totalCostCents: Cents;
  readonly totalDays: number;
  /** Exact average cost per diem (decimal string, cents/day) — "0" when there are no days. */
  readonly averageCostPerDiem: string;
  readonly medicareDays: number;
  readonly medicareCostCents: Cents;
  readonly medicaidDays: number;
  readonly medicaidCostCents: Cents;
}

export interface PerDiemResult {
  readonly levels: readonly PerDiemLevelResult[];
  readonly totalCostCents: Cents;
  readonly totalDays: number;
  readonly totalAverageCostPerDiem: string;
}

/** Compute Worksheet C. Per LOC: per diem = cost ÷ days; program cost = per diem × program days (HALF-UP).
 *  A level with zero days yields a "0" per diem and zero program cost (no division attempted). */
export function calculatePerDiem(input: PerDiemInput): PerDiemResult {
  const levels = input.levels.map((lvl): PerDiemLevelResult => {
    const perDiem = lvl.totalDays === 0 ? toDecimal(0) : ratio(lvl.totalCostCents, lvl.totalDays);
    return {
      levelOfCare: lvl.levelOfCare,
      totalCostCents: lvl.totalCostCents,
      totalDays: lvl.totalDays,
      averageCostPerDiem: lvl.totalDays === 0 ? "0" : perDiem.toString(),
      medicareDays: lvl.medicareDays,
      medicareCostCents: fromDecimal(perDiem.times(lvl.medicareDays)),
      medicaidDays: lvl.medicaidDays,
      medicaidCostCents: fromDecimal(perDiem.times(lvl.medicaidDays)),
    };
  });

  const totalCostCents = sumCents(levels.map((l) => l.totalCostCents));
  const totalDays = levels.reduce((s, l) => s + l.totalDays, 0);
  const totalAverageCostPerDiem =
    totalDays === 0 ? "0" : ratio(totalCostCents, totalDays).toString();
  return { levels, totalCostCents, totalDays, totalAverageCostPerDiem };
}
