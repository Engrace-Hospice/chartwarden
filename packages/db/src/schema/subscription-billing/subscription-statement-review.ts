// @chartwarden/db — `subscription_statement_review` (M35, slice 2 — migration 1412). One row per subscription-month the statement run could
// not bill (`no_census`: a live subscription whose month closed with no census day observed) or billed on thin evidence
// (`sparse_census`, migration 1465: the month closed on a census that covered too few of its days), written ONCE so an operator sees it
// without an hourly log line. PLATFORM-ONLY: RLS enabled and FORCEd with no policy and no chartwarden_app grant; read and written by the platform
// carrier, and audited through M1's baseline `chartwarden_audit_trigger()` (ids and a reason code only, so no denylist).
// `subject_organization_id` is deliberately not named organization_id (it is not a tenant-scoped row).
import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { subscriptionRow } from "./subscription";

export const subscriptionStatementReview = pgTable(
  "subscription_statement_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectOrganizationId: uuid("subject_organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    periodYearMonth: text("period_year_month").notNull(),
    reason: text("reason").$type<"no_census" | "sparse_census">().notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    onceUq: unique("subscription_statement_review_once_uq").on(
      t.subscriptionId,
      t.periodYearMonth,
      t.reason,
    ),
  }),
);

export type SubscriptionStatementReviewRow = typeof subscriptionStatementReview.$inferSelect;
