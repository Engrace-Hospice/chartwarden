// @wardenx/db — `report_definition` (M33 §3.3). A tenant- or system-authored report definition
// bound to a base; carries the optimistic-concurrency lock (version_seq) and a pointer to the
// latest published version. ORG-SCOPED: carries organization_id NOT NULL → standard app.org_id RLS
// (writes additionally require report.definition.write, §3.5). `base_key` refs report_base_catalog;
// cross-module refs (owner/published-by membership → M2) are plain uuid app-validated. RLS + grants
// + the M4 write-audit trigger land in the M33 RLS migration.
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { reportBaseCatalog } from "./report-base-catalog";

export const reportDefinition = pgTable(
  "report_definition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    authorship: text("authorship", { enum: ["system", "tenant"] }).notNull(),
    baseKey: text("base_key")
      .notNull()
      .references(() => reportBaseCatalog.baseKey),
    ownerMembershipId: uuid("owner_membership_id"), // nullable for system-authored
    displayName: text("display_name").notNull(),
    description: text("description"),
    latestVersionId: uuid("latest_version_id"), // points into report_definition_version
    versionSeq: integer("version_seq").notNull().default(0), // optimistic-concurrency lock
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    // §3.4: "list active tenant definitions" UI.
    orgStatusAuthorship: index("report_definition_org_status_authorship_idx").on(
      t.organizationId,
      t.status,
      t.authorship,
    ),
    // §3.4: the "where used" admin surface.
    baseStatus: index("report_definition_base_status_idx").on(t.baseKey, t.status),
    // #138/F-060/F-116 — at most one SYSTEM-authored definition per (org, base): the idempotency guard
    // for the day-one dashboard seeder, which runs on every accepted invitation (migration 0248).
    systemOrgBaseUq: uniqueIndex("report_definition_system_org_base_uq")
      .on(t.organizationId, t.baseKey)
      .where(sql`authorship = 'system'`),
  }),
);

export type ReportDefinition = typeof reportDefinition.$inferSelect;
export type NewReportDefinition = typeof reportDefinition.$inferInsert;
