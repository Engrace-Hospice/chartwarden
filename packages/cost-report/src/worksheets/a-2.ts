// @chartwarden/cost-report — Worksheet A2 (Reclassification & Adjustment of Trial Balance — Continuous Home Care) TypeBox
// schema (Form CMS-1984-14, Pub 15-2 §4311). The A-1…A-4 worksheets carry the reclassifications and
// adjustments for the DIRECT patient-care cost centers by level of care; A2 scopes the CHC direct-care
// trial balance. Its col. 7 line 100 total transfers into the Worksheet B step-down (B col. 0, the LOC line).
// Reclassifications are net-zero by construction. Money is INTEGER CENTS; no PHI (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4311 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`.
import { type Static, Type } from "@sinclair/typebox";

/** One reclassification/adjustment entry within the CHC direct-care trial balance. */
const A2Entry = Type.Object({
  costCenterCode: Type.String(),
  description: Type.String(),
  expenseLine: Type.Union([
    Type.Literal("salaries_and_wages"),
    Type.Literal("employee_benefits"),
    Type.Literal("contracted_services"),
    Type.Literal("supplies"),
    Type.Literal("other_costs"),
  ]),
  amountCents: Type.Integer(),
});

/** Worksheet A2 — Continuous Home Care direct-care trial balance (reclass/adjust). */
export const WorksheetA2 = Type.Object(
  {
    entries: Type.Array(A2Entry, { default: [] }),
    /** Col. 7 line 100 — net adjusted direct cost for CHC, transferred to Worksheet B col. 0. */
    netDirectCostCents: Type.Integer({ default: 0 }),
  },
  { additionalProperties: false },
);

export type WorksheetA2Data = Static<typeof WorksheetA2>;
