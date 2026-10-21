// @chartwarden/db — `report_definition_version` (M33 §3.3). An immutable-ish version snapshot of a
// report definition's spec (the persisted ReportDefinitionSpec jsonb); publish promotes it to the
// definition's latest and supersedes the prior. ORG-SCOPED: carries organization_id NOT NULL →
// standard app.org_id RLS (writes additionally require report.definition.write, §3.5).
// `definition_id` refs report_definition; cross-module membership refs are plain uuid app-validated.
// RLS + grants + the M4 write-audit trigger land in the M33 RLS migration.
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reportDefinition } from "./report-definition";
import type { ReportDefinitionSpec } from "./types";

export const reportDefinitionVersion = pgTable(
  "report_definition_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => reportDefinition.id),
    organizationId: uuid("organization_id").notNull(),
    versionNumber: integer("version_number").notNull(), // monotonic per definition
    spec: jsonb("spec").notNull().$type<ReportDefinitionSpec>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByMembershipId: uuid("published_by_membership_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    status: text("status", { enum: ["draft", "published", "superseded"] })
      .notNull()
      .default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id"),
  },
  (t) => ({
    // §3.4: latest-version-lookup (version_number desc in the migration).
    defVersion: index("report_definition_version_def_version_idx").on(
      t.definitionId,
      t.versionNumber,
    ),
    // §3.4: the recent-edits audit surface (published_at desc in the migration).
    orgPublished: index("report_definition_version_org_published_idx").on(
      t.organizationId,
      t.publishedAt,
    ),
  }),
);

export type ReportDefinitionVersion = typeof reportDefinitionVersion.$inferSelect;
export type NewReportDefinitionVersion = typeof reportDefinitionVersion.$inferInsert;
