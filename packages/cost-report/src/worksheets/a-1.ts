// @wardenx/cost-report — Worksheet A-1 (Reclassifications) TypeBox schema (CMS-1984-14, §1.1). A-1 moves
// costs BETWEEN cost centers to align the trial-balance classification with CMS cost-center definitions
// (e.g. moving a misclassified benefit out of "Administrative" into "Nursing"). Reclassifications are
// NET-ZERO by construction — every dollar moved out of one center moves into another — so the schema
// carries the net-balance tie flag the cross-worksheet validation asserts. Money is INTEGER CENTS; no PHI
// (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** A single reclassification entry: move `amountCents` from one cost center to another. */
const ReclassificationEntry = Type.Object({
  reclassCode: Type.String({ description: "lettered reclass code, e.g. A, B, C…" }),
  description: Type.String(),
  fromCostCenterCode: Type.String(),
  toCostCenterCode: Type.String(),
  /** Expense line affected (salaries / benefits / other) so the increase/decrease lands on the right column. */
  expenseLine: Type.Union([
    Type.Literal("salaries_and_wages"),
    Type.Literal("employee_benefits"),
    Type.Literal("contracted_services"),
    Type.Literal("supplies"),
    Type.Literal("other_costs"),
  ]),
  amountCents: Type.Integer({ description: "absolute amount moved; always positive" }),
});

/** Worksheet A-1 — reclassifications. */
export const WorksheetA1 = Type.Object(
  {
    reclassifications: Type.Array(ReclassificationEntry, { default: [] }),
    /** Sum of increases minus sum of decreases across all centers — must be exactly zero (net-zero tie). */
    netReclassBalanceCents: Type.Integer({ default: 0 }),
    netReclassBalancesToZero: Type.Boolean({ default: true }),
  },
  { additionalProperties: false },
);

export type WorksheetA1Data = Static<typeof WorksheetA1>;
