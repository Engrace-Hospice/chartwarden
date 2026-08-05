// M12 idempotency ledger for medication-recommendation decisions.
import { jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const medicationOrderIdgDecisionApplications = pgTable(
  "medication_order_idg_decision_application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    idgDecisionId: uuid("idg_decision_id").notNull(),
    medicationOrderIds: jsonb("medication_order_ids").notNull().$type<string[]>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionUnique: uniqueIndex("med_order_idg_application_org_decision_unique").on(
      t.organizationId,
      t.idgDecisionId,
    ),
  }),
);

export type MedicationOrderIdgDecisionApplication =
  typeof medicationOrderIdgDecisionApplications.$inferSelect;
