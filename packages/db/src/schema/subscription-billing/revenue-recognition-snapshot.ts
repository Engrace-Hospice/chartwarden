// @chartwarden/db — `revenue_recognition_snapshot` (M35 §3.3). Cross-tenant monthly MRR/ARR aggregate.
// PLATFORM-ONLY (no organization_id) — never exposed to tenant queries; read+write via wardenx_admin
// only (0143). Listed in check-tenancy's NON_ORG_SCOPED set.
import { bigint, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const revenueRecognitionSnapshot = pgTable(
  "revenue_recognition_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotMonth: text("snapshot_month").notNull(),
    mrrCents: bigint("mrr_cents", { mode: "number" }).notNull(),
    arrCents: bigint("arr_cents", { mode: "number" }).notNull(),
    newMrrCents: bigint("new_mrr_cents", { mode: "number" }).notNull(),
    expansionMrrCents: bigint("expansion_mrr_cents", { mode: "number" }).notNull(),
    contractionMrrCents: bigint("contraction_mrr_cents", { mode: "number" }).notNull(),
    churnMrrCents: bigint("churn_mrr_cents", { mode: "number" }).notNull(),
    activeSubscriptions: integer("active_subscriptions").notNull(),
    trialingSubscriptions: integer("trialing_subscriptions").notNull(),
    pastDueSubscriptions: integer("past_due_subscriptions").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    monthUq: uniqueIndex("revenue_recognition_snapshot_month_uq").on(t.snapshotMonth),
  }),
);

export type RevenueRecognitionSnapshotRow = typeof revenueRecognitionSnapshot.$inferSelect;
export type NewRevenueRecognitionSnapshotRow = typeof revenueRecognitionSnapshot.$inferInsert;
