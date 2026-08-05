// M11 idempotency ledger for the M14 IDG order-intake command.
import { jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const orderIdgDecisionApplications = pgTable(
  "order_idg_decision_application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    idgDecisionId: uuid("idg_decision_id").notNull(),
    orderIds: jsonb("order_ids").notNull().$type<string[]>(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionUnique: uniqueIndex("order_idg_decision_application_org_decision_unique").on(
      t.organizationId,
      t.idgDecisionId,
    ),
  }),
);

export type OrderIdgDecisionApplication = typeof orderIdgDecisionApplications.$inferSelect;
