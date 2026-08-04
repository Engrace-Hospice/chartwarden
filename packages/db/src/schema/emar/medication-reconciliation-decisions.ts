import { sql } from "drizzle-orm";
// @wardenx/db — `medication_reconciliation_decision` (M13 §3.3 / §2.8 D17). One per-line decision on a
// reconciliation worksheet: the line source (an M12 active order, an M12 medhx record, or a caregiver-reported
// home med — the latter a denylisted structured jsonb), the decision, and the back-ref to any resulting M12 order.
// Org-scoped (no patient row — the parent worksheet carries it); standard app.org_id RLS. Non-partitioned.
// `worksheet_id` is M13-owned but kept loose (no SQL FK); the M12 refs are logical FKs (resolved through seam).
// RLS + grants + the M4 write-audit trigger (decision_notes + caregiver_reported_snapshot denylisted, §3.6) land
// in the RLS migration.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reconciliationDecisionKind } from "../../enums";
import { organizations } from "../organizations";

export const medicationReconciliationDecisions = pgTable(
  "medication_reconciliation_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    worksheetId: uuid("worksheet_id").notNull(), // M13 (loose; no FK)

    // The line — could be an M12 active order, an M12 medhx record, or a caregiver-reported home med.
    lineKind: text("line_kind").notNull(), // 'm12_active' | 'm12_medhx' | 'caregiver_reported'
    m12MedicationOrderId: uuid("m12_medication_order_id"), // if lineKind = m12_active
    m12MedicationHistoryRecordId: uuid("m12_medication_history_record_id"), // if lineKind = m12_medhx
    caregiverReportedSnapshot: jsonb("caregiver_reported_snapshot"), // DENYLISTED structured payload

    decisionKind: reconciliationDecisionKind("decision_kind").notNull(),
    decisionMadeAt: timestamp("decision_made_at", { withTimezone: true }).notNull().defaultNow(),
    decisionMadeByMembershipId: uuid("decision_made_by_membership_id").notNull(),
    decisionNotes: text("decision_notes"), // DENYLISTED

    // Back-reference to the resulting M12 order if the decision led to a new draft/order.
    resultingMedicationOrderId: uuid("resulting_medication_order_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorksheet: index("recon_dec_worksheet_idx").on(t.worksheetId),
    byOrder: index("recon_dec_order_idx")
      .on(t.organizationId, t.m12MedicationOrderId)
      .where(sql`m12_medication_order_id IS NOT NULL`),
  }),
);

export type MedicationReconciliationDecision =
  typeof medicationReconciliationDecisions.$inferSelect;
export type NewMedicationReconciliationDecision =
  typeof medicationReconciliationDecisions.$inferInsert;
