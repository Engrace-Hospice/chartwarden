// @wardenx/cost-report — Worksheet F-2 (Statement of Revenues and Operating Expenses) TypeBox schema (Form
// CMS-1984-14, Pub 15-2 §4352). F-2 reports operating revenue by source and operating expense, yielding the
// net income/loss that feeds Worksheet F-1. Money is INTEGER CENTS; no PHI (D18).
//
// CMS-CERT: certified against the form + Ch.43 §4352 (audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md).
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Worksheet F-2 — statement of revenues and operating expenses. */
export const WorksheetF2 = Type.Object(
  {
    netPatientServiceRevenueCents: Type.Integer({ default: 0 }),
    otherOperatingRevenueCents: Type.Integer({ default: 0 }),
    totalOperatingRevenueCents: Type.Integer({ default: 0 }),
    totalOperatingExpensesCents: Type.Integer({ default: 0 }),
    /** Total operating revenue − total operating expenses (feeds Worksheet F-1 net income/loss). */
    netIncomeLossCents: Type.Integer({ default: 0 }),
  },
  { additionalProperties: false },
);

export type WorksheetF2Data = Static<typeof WorksheetF2>;
