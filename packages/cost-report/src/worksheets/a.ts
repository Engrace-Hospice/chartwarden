// @wardenx/cost-report — Worksheet A (Trial Balance of Expenses / Cost Centers) TypeBox schema
// (CMS-1984-14, §4.2 / §1.1). Mirrors the §4.2 representative schema EXACTLY: each CMS cost center's
// salaries, benefits, contracted services, supplies, and other costs, with a per-center total that must
// equal the sum of its components, plus the column totals and a grand total, and the cross-worksheet tie
// flag asserting the grand total reconciles to the imported trial balance within a dollar. All money is
// INTEGER CENTS; no PHI — aggregate GL totals only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** Worksheet A — trial balance of expenses by cost center. Field set is verbatim from spec §4.2. */
export const WorksheetA = Type.Object({
  costCenters: Type.Array(
    Type.Object({
      code: Type.String(), // cms_cost_center_v1984_14 code
      name: Type.String(),
      salariesAndWagesCents: Type.Integer(),
      employeeBenefitsCents: Type.Integer(),
      contractedServicesCents: Type.Integer(),
      suppliesCents: Type.Integer(),
      otherCostsCents: Type.Integer(),
      totalCostsCents: Type.Integer(), // must equal sum of components
    }),
  ),
  totalSalariesAndWagesCents: Type.Integer(),
  totalEmployeeBenefitsCents: Type.Integer(),
  totalContractedServicesCents: Type.Integer(),
  totalSuppliesCents: Type.Integer(),
  totalOtherCostsCents: Type.Integer(),
  grandTotalCostsCents: Type.Integer(),
  tiesToTrialBalanceWithinDollar: Type.Boolean(),
});

export type WorksheetAData = Static<typeof WorksheetA>;
