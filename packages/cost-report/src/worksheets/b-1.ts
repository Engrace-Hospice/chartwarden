// @wardenx/cost-report — Worksheet B-1 (Cost Allocation – Statistical Basis) TypeBox schema
// (Form CMS-1984-14, Pub 15-2 §4320). B-1 is the STATISTICAL BASIS that drives the Worksheet B step-down:
// for each general-service (overhead) cost center it records the recommended allocation statistic (square
// feet, in-facility days, gross salaries, accumulated cost, …), the total statistic base, and that portion
// of the base applicable to each RECEIVING cost center. Per §4320 the unit cost multiplier =
// (total cost to allocate ÷ total statistic base) is rounded to SIX decimal places (line 102), and A&G is
// allocated on ACCUMULATED COST (Worksheet B, col. 3A). The general format of B-1 is identical to B (same
// row/column codes). Money is INTEGER CENTS; statistics are fractional; no PHI (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4320 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** One general-service cost center's statistical-basis column: its recommended basis, total statistic, and the
 *  portion of that statistic applicable to each receiving center (the sum of portions must equal the total). */
const StatisticalBasisColumn = Type.Object({
  generalServiceCostCenterCode: Type.String(),
  /** The recommended allocation statistic for this column (square_feet, accumulated_cost, gross_salaries, …). */
  allocationBasis: Type.String(),
  /** Total statistic base for the cost center being allocated (B-1 line 1 of the column). */
  totalStatisticBase: Type.Number({ default: 0 }),
  /** Unit cost multiplier = total cost (B-1 line 101) ÷ total statistic base, rounded to SIX decimals (line 102). */
  unitCostMultiplier: Type.String({ default: "0", description: "decimal string, 6 dp (§4320)" }),
  /** Portion of the total statistic applicable to each receiving cost center (Σ portions = totalStatisticBase). */
  statisticalPortions: Type.Array(
    Type.Object({ receivingCenterCode: Type.String(), statisticValue: Type.Number() }),
    { default: [] },
  ),
});

/** Worksheet B-1 — cost-allocation statistical basis. */
export const WorksheetB1 = Type.Object(
  {
    columns: Type.Array(StatisticalBasisColumn, { default: [] }),
    /** A&G (Administrative & General) is allocated on accumulated cost (Worksheet B col. 3A) per §4320. */
    andGAllocatedOnAccumulatedCost: Type.Boolean({ default: true }),
    /** Each column's receiving-center portions sum to its total statistic base (the §4320 cross-foot). */
    portionsTieToTotalBase: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetB1Data = Static<typeof WorksheetB1>;
