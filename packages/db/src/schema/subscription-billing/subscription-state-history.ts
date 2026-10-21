// @chartwarden/db — `subscription_state_history` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143).
// Append-only §2.2 transition ledger. `subscription_id` is a REAL FK. `organization_id` is a logical uuid
// (M35-F04). `actor_membership_id` is NULL for system transitions.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { subscriptionStatus } from "../../enums";
import { subscriptionRow } from "./subscription";

export const subscriptionStateHistory = pgTable(
  "subscription_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    fromStatus: subscriptionStatus("from_status"),
    toStatus: subscriptionStatus("to_status").notNull(),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    actorMembershipId: uuid("actor_membership_id"),
    reasonCode: text("reason_code").notNull(),
    reasonDetail: text("reason_detail"),
    stripeEventId: text("stripe_event_id"),
    m4AuditEventId: uuid("m4_audit_event_id"),
  },
  (t) => ({
    subIx: index("subscription_state_history_sub_ix").on(t.subscriptionId, t.transitionedAt),
  }),
);

export type SubscriptionStateHistoryRow = typeof subscriptionStateHistory.$inferSelect;
export type NewSubscriptionStateHistoryRow = typeof subscriptionStateHistory.$inferInsert;
