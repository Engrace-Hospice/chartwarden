// @wardenx/cost-report — Worksheet F-1 (Statement of Changes in Fund Balances) TypeBox schema (Form
// CMS-1984-14, Pub 15-2 §4351). F-1 reconciles the opening fund balance to the closing fund balance via the
// net income/loss and other equity changes — it ties Worksheet F (balance sheet) period over period. Money
// is INTEGER CENTS; no PHI (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4351 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet F-1 — statement of changes in fund balances. */
export const WorksheetF1 = Type.Object(
  {
    openingFundBalanceCents: Type.Integer({ default: 0 }),
    netIncomeLossCents: Type.Integer({ default: 0 }),
    otherEquityChangesCents: Type.Integer({ default: 0 }),
    closingFundBalanceCents: Type.Integer({ default: 0 }),
    /** opening + net income + other changes == closing, and closing ties to Worksheet F net assets. */
    tiesToWorksheetF: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetF1Data = Static<typeof WorksheetF1>;
