// @wardenx/db — `report_view` (M33 §3.3). A saved view over a definition version: owner, pinned
// filters, share scope (private/role/org), and the org-default flag. ORG-SCOPED: carries
// organization_id NOT NULL → standard app.org_id RLS (writes additionally require report.view.write
// + ownership / org_admin for org-default, §3.5). `definition_version_id` refs
// report_definition_version; owner membership ref is plain uuid app-validated. RLS + grants + the M4
// write-audit trigger land in the M33 RLS migration.
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reportDefinitionVersion } from "./report-definition-version";
import type { ReportFilter } from "./types";

export const reportView = pgTable(
  "report_view",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    definitionVersionId: uuid("definition_version_id")
      .notNull()
      .references(() => reportDefinitionVersion.id),
    ownerMembershipId: uuid("owner_membership_id").notNull(),
    displayName: text("display_name").notNull(),
    pinnedFilters: jsonb("pinned_filters").notNull().$type<ReportFilter[]>().default([]),
    shareScope: text("share_scope", { enum: ["private", "role", "org"] })
      .notNull()
      .default("private"),
    shareRoleKeys: jsonb("share_role_keys").$type<string[]>(),
    isOrgDefault: boolean("is_org_default").notNull().default(false),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // §3.4: "my views".
    orgOwnerStatus: index("report_view_org_owner_status_idx").on(
      t.organizationId,
      t.ownerMembershipId,
      t.status,
    ),
    // §3.4: the org default surface (partial WHERE share_scope='org').
    orgShareDefault: index("report_view_org_share_default_idx")
      .on(t.organizationId, t.shareScope, t.status)
      .where(sql`${t.shareScope} = 'org'`),
  }),
);

export type ReportView = typeof reportView.$inferSelect;
export type NewReportView = typeof reportView.$inferInsert;
