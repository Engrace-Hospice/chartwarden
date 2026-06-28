// @wardenx/cost-report — Worksheet G-1 (Statement of Changes in Fund Balance / Net Assets) TypeBox schema
// (CMS-1984-14, §1.1). G-1 rolls the beginning fund balance forward by the period net income (from G) plus
// any other equity changes (contributions, distributions, prior-period adjustments) to the ending fund
// balance, which must equal Worksheet F total net assets (rollforward tie). All money is INTEGER CENTS
// (signed); no PHI — entity equity only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet G-1 — statement of changes in fund balance / net assets. */
export const WorksheetG1 = Type.Object(
  {
    beginningFundBalanceCents: Type.Integer({ default: 0 }),
    netIncomeForPeriodCents: Type.Integer({ default: 0, description: "from Worksheet G net income" }),
    contributionsCents: Type.Integer({ default: 0 }),
    distributionsCents: Type.Integer({ default: 0, description: "owner draws / dividends; signed" }),
    priorPeriodAdjustmentsCents: Type.Integer({ default: 0 }),
    /** beginning + net income + contributions − distributions + prior-period adjustments. */
    endingFundBalanceCents: Type.Integer({ default: 0 }),
    /** Rollforward tie: ending fund balance must equal Worksheet F total net assets. */
    tiesToWorksheetFNetAssets: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetG1Data = Static<typeof WorksheetG1>;
