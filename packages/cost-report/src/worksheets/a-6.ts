// @wardenx/cost-report — Worksheet A-6 (Adjustments to Expenses) TypeBox schema (CMS-1984-14, §1.1). A-6
// REMOVES non-allowable / non-reimbursable costs from the trial balance (e.g. advertising, bad-debt expense
// already claimed elsewhere, owner-compensation in excess of reasonable, investment income offsets). Unlike
// A-1 reclassifications, A-6 adjustments are NOT net-zero — they reduce (or, rarely, increase) the allowable
// cost base. Each adjustment names its allowability basis. Money is INTEGER CENTS (negative = a reduction of
// allowable cost); no PHI (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** A single adjustment entry against a cost center's expenses. */
const AdjustmentEntry = Type.Object({
  adjustmentCode: Type.String(),
  description: Type.String(),
  costCenterCode: Type.String(),
  basis: Type.Union([
    Type.Literal("non_allowable_cost"),
    Type.Literal("offset_to_expense"),
    Type.Literal("related_party_adjustment"),
    Type.Literal("investment_income_offset"),
    Type.Literal("other"),
  ]),
  /** Signed cents — negative reduces allowable cost (the common case), positive adds it back. */
  amountCents: Type.Integer(),
  basisExplanation: Type.Optional(Type.String()),
});

/** Worksheet A-6 — adjustments to expenses. */
export const WorksheetA6 = Type.Object(
  {
    adjustments: Type.Array(AdjustmentEntry, { default: [] }),
    /** Net of all adjustments (signed cents); flows into the Worksheet A allowable-cost reconciliation. */
    totalAdjustmentsCents: Type.Integer({ default: 0 }),
  },
  { additionalProperties: false },
);

export type WorksheetA6Data = Static<typeof WorksheetA6>;
