// @wardenx/db — M25 Remittance & Denials §3.3 — the patient-responsibility (PR) ledger. Read-only in
// Phase 1: a CAS group-code `PR` adjustment records one row here; the future Patient Statement module
// (Phase 2) consumes it via PatientResponsibilityReader. No collections workflow (D8).
//
// NON-partitioned. organization_id NOT NULL → standard app.org_id RLS. patient_id is PHI-bearing, so
// the table also follows the three-column posture via the org scope; patient_id (M5), remittance_line_id
// / remittance_adjustment_id (partitioned M25) are LOGICAL uuid FKs — only organization_id →
// organizations is a real FK. CHECK pr_amount > 0 lands in the SQL migration (§2.3).
import { index, numeric, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m25PrLedgerStatus } from "./enums";

export const patientResponsibilityLedger = pgTable(
  "patient_responsibility_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 logical FK
    remittanceLineId: uuid("remittance_line_id").notNull(), // logical FK → remittance_line (partitioned)
    remittanceAdjustmentId: uuid("remittance_adjustment_id").notNull(), // logical FK → remittance_adjustment
    prAmount: numeric("pr_amount", { precision: 12, scale: 2 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    status: m25PrLedgerStatus("status").notNull().default("recorded"),
    invoiceRef: varchar("invoice_ref", { length: 80 }), // nullable, future Patient Statement
  },
  (t) => ({
    byPatient: index("ix_pr_ledger_patient").on(t.patientId, t.recordedAt),
    byStatus: index("ix_pr_ledger_status").on(t.status),
  }),
);
