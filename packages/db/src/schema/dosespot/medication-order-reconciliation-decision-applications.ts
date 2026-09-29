// M12 idempotency ledger for M13 §2.8 D17 reconciliation-decision draft-order handshakes (F-16x, #248) —
// the `medication_order_idg_decision_application` precedent (same file, IDG variant) applied to
// `m13.reconciliation.draft_order_requested` instead: `medication_order` is a monthly range-partitioned
// table (on created_at), so a direct unique constraint on (organization_id,
// triggering_reconciliation_decision_id) cannot exist there (Postgres requires the partition key in every
// unique index on a partitioned table), so a redelivery-safe consumer needs a separate, non-partitioned
// ledger row (this table) checked before it inserts the draft order.
import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const medicationOrderReconciliationDecisionApplications = pgTable(
  "medication_order_reconciliation_decision_application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reconciliationDecisionId: uuid("reconciliation_decision_id").notNull(), // M13 (loose; no FK)
    medicationOrderId: uuid("medication_order_id").notNull(), // the minted draft (loose; no FK — partitioned)
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionUnique: uniqueIndex("med_order_recon_application_org_decision_unique").on(
      t.organizationId,
      t.reconciliationDecisionId,
    ),
  }),
);

export type MedicationOrderReconciliationDecisionApplication =
  typeof medicationOrderReconciliationDecisionApplications.$inferSelect;
