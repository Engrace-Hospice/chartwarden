// @wardenx/cost-report — Worksheet G (Statement of Revenues and Expenses) TypeBox schema (CMS-1984-14,
// §1.1). G is the provider income statement: total operating revenue less total operating expense yields
// net income, reconciled to the G-1 change in fund balance. The total operating expense here cross-ties to
// the Worksheet A grand total of costs. All money is INTEGER CENTS (revenues and expenses positive; net
// income signed); no PHI — entity financials only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet G — statement of revenues and expenses. */
export const WorksheetG = Type.Object(
  {
    operatingRevenue: Type.Object({
      netPatientServiceRevenueCents: Type.Integer({ default: 0 }),
      otherOperatingRevenueCents: Type.Integer({ default: 0 }),
      totalOperatingRevenueCents: Type.Integer({ default: 0 }),
    }),
    operatingExpense: Type.Object({
      totalOperatingExpenseCents: Type.Integer({ default: 0 }),
    }),
    netOperatingIncomeCents: Type.Integer({ default: 0 }),
    nonOperatingGainsCents: Type.Integer({ default: 0 }),
    /** Net income for the year (signed); flows into G-1 as the period change in fund balance. */
    netIncomeCents: Type.Integer({ default: 0 }),
    /** Cross-worksheet tie: total operating expense reconciles to Worksheet A grand total of costs. */
    tiesToWorksheetAGrandTotal: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetGData = Static<typeof WorksheetG>;
