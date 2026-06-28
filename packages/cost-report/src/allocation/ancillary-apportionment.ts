// @wardenx/cost-report — M27 Worksheet C ANCILLARY apportionment, ratio-of-cost-to-charges (§1.1, D8).
// The second hop of the propagation chain (A → B → C → D → E-1): for each ancillary cost center the
// fully-allocated Worksheet B cost is divided by the center's total charges to yield a cost-to-charge
// ratio (RCC); applying the RCC to the program-attributable charges apportions the center's cost to each
// program (Medicare / Medicaid / other). The program lines are penny-true (largest-remainder) against
// the apportioned subtotal so the per-program cost ties exactly to RCC × Σ(program charges) to the cent.
//
// PURE DOMAIN, deterministic total function over an already-fetched input: no Fastify, no Drizzle/DB, no
// BullMQ, no `@wardenx/db`, no `getSeam`. Money is INTEGER CENTS at the boundary; the RCC is carried as a
// decimal STRING (never a float) for audit. No PHI — aggregate financial/statistical only (D18).
import { allocateProportional, fromDecimal, ratio, toDecimal } from "../domain/money";
import type { Cents } from "../domain/money";

/** The payer programs a cost center's charges (and apportioned cost) are split across. */
export type CostReportProgram = "medicare" | "medicaid" | "other";

/** Deterministic program ordering used to break apportionment ties and to order output lines. */
export const COST_REPORT_PROGRAMS: readonly CostReportProgram[] = ["medicare", "medicaid", "other"] as const;

/**
 * One ancillary cost center entering Worksheet C: its fully-allocated Worksheet B cost, its total
 * charges, and the charges attributable to each program. Program charges may sum to LESS than total
 * charges (non-program charges exist); only the program-charge portion of cost is apportioned.
 */
export interface AncillaryCostCenter {
  readonly code: string;
  readonly name: string;
  readonly totalCostCents: Cents;
  readonly totalChargesCents: Cents;
  readonly programCharges: ReadonlyArray<{ readonly program: CostReportProgram; readonly chargesCents: Cents }>;
}

/** The fully-fetched Worksheet C input. */
export interface AncillaryApportionInput {
  readonly costCenters: readonly AncillaryCostCenter[];
}

/** One apportioned program line for an ancillary center. */
export interface AncillaryProgramLine {
  readonly program: CostReportProgram;
  readonly chargesCents: Cents;
  readonly apportionedCostCents: Cents;
}

/** A Worksheet C row: the center, its RCC (decimal string), and the per-program apportioned cost. */
export interface WorksheetCAncillaryResult {
  readonly code: string;
  readonly name: string;
  readonly totalCostCents: Cents;
  readonly totalChargesCents: Cents;
  /** Cost-to-charge ratio as an exact decimal string (e.g. "0.8423"); "0" when there are no charges. */
  readonly costToChargeRatio: string;
  readonly programLines: readonly AncillaryProgramLine[];
  /** RCC × Σ(program charges), rounded to whole cents — the sum the program lines tie to exactly. */
  readonly apportionedSubtotalCents: Cents;
}

/** The Worksheet C result across every ancillary center. */
export interface AncillaryApportionResult {
  readonly centers: readonly WorksheetCAncillaryResult[];
}

/**
 * Apportion each ancillary center's Worksheet B cost to programs by ratio-of-cost-to-charges. For a
 * center with zero total charges the RCC is "0" and every program line is zero (no division attempted).
 * Otherwise the apportioned subtotal is RCC × Σ(program charges) rounded to cents, then split across the
 * programs by their charge weights with `allocateProportional` so the lines sum to that subtotal exactly.
 * Program lines are emitted in `COST_REPORT_PROGRAMS` order for determinism.
 */
export function apportionAncillary(input: AncillaryApportionInput): AncillaryApportionResult {
  const centers = input.costCenters.map((center): WorksheetCAncillaryResult => {
    // Normalize program charges into the canonical program order (missing programs default to 0).
    const chargesByProgram = new Map<CostReportProgram, Cents>();
    for (const pc of center.programCharges) {
      chargesByProgram.set(pc.program, (chargesByProgram.get(pc.program) ?? 0) + pc.chargesCents);
    }
    const orderedCharges = COST_REPORT_PROGRAMS.map((program) => ({
      program,
      chargesCents: chargesByProgram.get(program) ?? 0,
    }));

    if (center.totalChargesCents === 0) {
      return {
        code: center.code,
        name: center.name,
        totalCostCents: center.totalCostCents,
        totalChargesCents: center.totalChargesCents,
        costToChargeRatio: "0",
        programLines: orderedCharges.map((c) => ({ ...c, apportionedCostCents: 0 })),
        apportionedSubtotalCents: 0,
      };
    }

    // RCC = cost / charges, kept in the decimal domain (carried out as a string for audit, never a float).
    const rcc = ratio(center.totalCostCents, center.totalChargesCents);
    const programChargesTotal = orderedCharges.reduce((acc, c) => acc + c.chargesCents, 0);
    const apportionedSubtotalCents = fromDecimal(toDecimal(programChargesTotal).times(rcc));

    const weights = orderedCharges.map((c) => c.chargesCents);
    const parts = allocateProportional(apportionedSubtotalCents, weights);
    const programLines = orderedCharges.map((c, i) => ({
      program: c.program,
      chargesCents: c.chargesCents,
      apportionedCostCents: parts[i]!,
    }));

    return {
      code: center.code,
      name: center.name,
      totalCostCents: center.totalCostCents,
      totalChargesCents: center.totalChargesCents,
      costToChargeRatio: rcc.toString(),
      programLines,
      apportionedSubtotalCents,
    };
  });

  return { centers };
}
