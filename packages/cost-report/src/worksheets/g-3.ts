// @wardenx/cost-report — Worksheet G-3 (Statement of Operating & Other Expenses) TypeBox schema
// (CMS-1984-14, §1.1). G-3 details total operating expense by natural classification (salaries, benefits,
// contracted services, supplies, depreciation, interest, other) plus non-operating expense, reconciling to
// the Worksheet G total operating expense (and, through it, the Worksheet A grand total). All money is
// INTEGER CENTS; no PHI — entity expense detail only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet G-3 — statement of operating & other expenses by natural classification. */
export const WorksheetG3 = Type.Object(
  {
    operatingExpenseByNaturalClass: Type.Object({
      salariesAndWagesCents: Type.Integer({ default: 0 }),
      employeeBenefitsCents: Type.Integer({ default: 0 }),
      contractedServicesCents: Type.Integer({ default: 0 }),
      suppliesCents: Type.Integer({ default: 0 }),
      depreciationCents: Type.Integer({ default: 0 }),
      interestCents: Type.Integer({ default: 0 }),
      otherOperatingExpenseCents: Type.Integer({ default: 0 }),
      totalOperatingExpenseCents: Type.Integer({ default: 0 }),
    }),
    nonOperatingExpenseCents: Type.Integer({ default: 0 }),
    /** Cross-worksheet tie: total operating expense reconciles to Worksheet G (and Worksheet A grand total). */
    tiesToWorksheetGOperatingExpense: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetG3Data = Static<typeof WorksheetG3>;
