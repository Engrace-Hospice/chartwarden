// @wardenx/db — `report_share` (M33 §3.3). An explicit share grant for a saved view — either to a
// specific membership (rare) or to a role key. ORG-SCOPED: carries organization_id NOT NULL →
// standard app.org_id RLS (writes additionally require report.share.org or self-role share, §3.5).
// `report_view_id` refs report_view; shared-with membership ref is plain uuid app-validated. RLS +
// grants + the M4 write-audit trigger land in the M33 RLS migration.
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reportView } from "./report-view";

export const reportShare = pgTable("report_share", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  reportViewId: uuid("report_view_id")
    .notNull()
    .references(() => reportView.id),
  sharedWithMembershipId: uuid("shared_with_membership_id"), // for explicit-membership share (rarely used)
  sharedWithRoleKey: text("shared_with_role_key"), // for role share
  status: text("status", { enum: ["active", "revoked"] })
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type ReportShare = typeof reportShare.$inferSelect;
export type NewReportShare = typeof reportShare.$inferInsert;
