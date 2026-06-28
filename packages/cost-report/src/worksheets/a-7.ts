// @wardenx/cost-report — Worksheet A-7 (Analysis of Capital-Related Costs / Reconciliation) TypeBox schema
// (CMS-1984-14, §1.1). A-7 details the capital-related costs that flow through the cost centers —
// depreciation by asset class, interest on capital indebtedness, lease/rental of plant & equipment, and
// insurance/taxes on capital — and reconciles the fixed-asset rollforward (beginning balance + additions −
// disposals = ending balance). Money is INTEGER CENTS; no PHI — capital/asset financials only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Capital cost detail for one asset class / capital line. */
const CapitalCostLine = Type.Object({
  category: Type.Union([
    Type.Literal("depreciation_buildings"),
    Type.Literal("depreciation_fixed_equipment"),
    Type.Literal("depreciation_movable_equipment"),
    Type.Literal("interest_capital"),
    Type.Literal("lease_rental"),
    Type.Literal("insurance_taxes_capital"),
    Type.Literal("other_capital"),
  ]),
  description: Type.Optional(Type.String()),
  amountCents: Type.Integer(),
});

/** Worksheet A-7 — analysis of capital-related costs + fixed-asset reconciliation. */
export const WorksheetA7 = Type.Object(
  {
    capitalCostLines: Type.Array(CapitalCostLine, { default: [] }),
    totalCapitalRelatedCostsCents: Type.Integer({ default: 0 }),
    /** Fixed-asset rollforward — beginning + additions − disposals must equal ending (reconciliation tie). */
    fixedAssetRollforward: Type.Object({
      beginningBalanceCents: Type.Integer({ default: 0 }),
      additionsCents: Type.Integer({ default: 0 }),
      disposalsCents: Type.Integer({ default: 0 }),
      endingBalanceCents: Type.Integer({ default: 0 }),
    }),
    fixedAssetRollforwardTies: Type.Boolean({ default: false }),
    // TODO(CMS-fixture): the exact A-7 capital-line ordering + the depreciation-method columns require a
    // CMS-published CMS-1984-14 A-7 image to confirm line conformance; the above is the internally-tied-out
    // superset M27 computes against until then.
  },
  { additionalProperties: false },
);

export type WorksheetA7Data = Static<typeof WorksheetA7>;
