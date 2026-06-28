// @wardenx/cost-report — Worksheet G-2 (Statement of Patient Revenues) TypeBox schema (CMS-1984-14, §1.1).
// G-2 details gross patient revenue by payer program (Medicare / Medicaid / other) and by level of care,
// less contractual allowances and other deductions, to arrive at the net patient service revenue that ties
// to Worksheet G. All money is INTEGER CENTS; no PHI — aggregate revenue by program only (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Gross patient revenue for one program, broken out by level of care. */
const ProgramPatientRevenue = Type.Object({
  rhcRevenueCents: Type.Integer({ default: 0 }),
  chcRevenueCents: Type.Integer({ default: 0 }),
  ircRevenueCents: Type.Integer({ default: 0 }),
  gipRevenueCents: Type.Integer({ default: 0 }),
  totalRevenueCents: Type.Integer({ default: 0 }),
});

/** Worksheet G-2 — statement of patient revenues. */
export const WorksheetG2 = Type.Object(
  {
    medicare: ProgramPatientRevenue,
    medicaid: ProgramPatientRevenue,
    other: ProgramPatientRevenue,
    grossPatientRevenueCents: Type.Integer({ default: 0 }),
    contractualAllowancesCents: Type.Integer({ default: 0, description: "deduction; positive magnitude" }),
    otherDeductionsCents: Type.Integer({ default: 0 }),
    /** gross − contractual allowances − other deductions; ties to Worksheet G net patient service revenue. */
    netPatientServiceRevenueCents: Type.Integer({ default: 0 }),
    tiesToWorksheetGRevenue: Type.Boolean({ default: false }),
  },
  { additionalProperties: false },
);

export type WorksheetG2Data = Static<typeof WorksheetG2>;
