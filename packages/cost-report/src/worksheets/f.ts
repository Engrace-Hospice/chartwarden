// @wardenx/cost-report — Worksheet F (Balance Sheet) TypeBox schema (CMS-1984-14, §1.1). F is the
// provider's fiscal-year-end balance sheet: assets = liabilities + net assets/fund balance. The schema
// carries the accounting identity tie flag the cross-worksheet validation asserts (total assets must equal
// total liabilities plus equity to the dollar). All money is INTEGER CENTS; no PHI — entity financials only
// (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet F — balance sheet at fiscal-year-end. */
export const WorksheetF = Type.Object(
  {
    assets: Type.Object({
      currentAssetsCents: Type.Integer({ default: 0 }),
      propertyPlantEquipmentNetCents: Type.Integer({ default: 0 }),
      otherAssetsCents: Type.Integer({ default: 0 }),
      totalAssetsCents: Type.Integer({ default: 0 }),
    }),
    liabilities: Type.Object({
      currentLiabilitiesCents: Type.Integer({ default: 0 }),
      longTermDebtCents: Type.Integer({ default: 0 }),
      otherLiabilitiesCents: Type.Integer({ default: 0 }),
      totalLiabilitiesCents: Type.Integer({ default: 0 }),
    }),
    netAssets: Type.Object({
      fundBalanceCents: Type.Integer({ default: 0 }),
      retainedEarningsCents: Type.Integer({ default: 0 }),
      totalNetAssetsCents: Type.Integer({ default: 0 }),
    }),
    /** Accounting identity: totalAssets must equal totalLiabilities + totalNetAssets (to the dollar). */
    balanceSheetBalances: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetFData = Static<typeof WorksheetF>;
