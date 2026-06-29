// ⚠️ CMS-DIVERGENCE (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md): on the REAL Form CMS-1984-14, Worksheet C
// is "Calculation of Per Diem Cost" (§4330) — hospice has NO ancillary ratio-of-cost-to-charges. This RCC
// model is not on the hospice form; pending the worksheet-model realignment recorded in the ledger.
// @wardenx/cost-report — Worksheet C (Ancillary Service Cost / Ratio of Cost to Charges) TypeBox schema
// (CMS-1984-14, §4.2 / §1.1). C is a DERIVED worksheet: for each ancillary cost center it computes the
// ratio of cost to charges (RCC = fully-allocated cost ÷ total charges) and applies it to program charges
// to derive program ancillary cost. The RCC is a dimensionless `decimal.js` ratio (`ratio()` — throws on a
// zero-charge basis rather than yielding Infinity, D8); the resulting program cost is rounded to whole
// cents (HALF_UP). All money is INTEGER CENTS; ratios are fractional `Type.Number`. No PHI (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** One ancillary cost center's RCC apportionment row. */
const AncillaryCostCenter = Type.Object({
  code: Type.String(),
  name: Type.String(),
  fullyAllocatedCostCents: Type.Integer({ description: "from Worksheet B" }),
  totalChargesCents: Type.Integer({ description: "gross charges for the center; RCC denominator" }),
  /** ratioOfCostToCharges = fullyAllocatedCostCents / totalChargesCents (dimensionless, not rounded to cents). */
  ratioOfCostToCharges: Type.Number({ default: 0 }),
  medicareChargesCents: Type.Integer({ default: 0 }),
  /** medicareChargesCents × ratioOfCostToCharges, rounded HALF_UP to whole cents. */
  medicareCostCents: Type.Integer({ default: 0 }),
});

/** Worksheet C — ancillary service cost apportionment (ratio of cost to charges). */
export const WorksheetC = Type.Object(
  {
    ancillaryCostCenters: Type.Array(AncillaryCostCenter, { default: [] }),
    totalMedicareAncillaryCostCents: Type.Integer({ default: 0 }),
    /** A zero-charge basis cannot drive an RCC — flagged for the validation worklist, not silently zeroed. */
    hasZeroChargeBasisFlag: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetCData = Static<typeof WorksheetC>;
