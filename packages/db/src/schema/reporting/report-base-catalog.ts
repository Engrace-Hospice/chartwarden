// @wardenx/db — `report_base_catalog` (M33 §3.3). The platform-global catalog of report bases:
// each base binds a `report_mv` materialized view (mv_key) to a dimension/measure catalog and the
// drilldown-URL template. PLATFORM-scoped: NO organization_id (retention class `platform`); sits on
// the check-tenancy NON_ORG_SCOPED allowlist. `mv_key` is a logical+SQL ref into
// materialized_view_metadata.mv_key. RLS + grants land in the M33 RLS migration.
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { materializedViewMetadata } from "./materialized-view-metadata";
import type { DimensionCatalog, MeasureCatalog } from "./types";

export const reportBaseCatalog = pgTable("report_base_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  baseKey: text("base_key").notNull().unique(), // e.g., 'encounter_productivity_membership_day'
  displayName: text("display_name").notNull(),
  domain: text("domain").notNull(), // 'census' | 'productivity' | 'clinical' | ...
  description: text("description").notNull(),
  mvKey: text("mv_key")
    .notNull()
    .references(() => materializedViewMetadata.mvKey),
  dimensions: jsonb("dimensions").notNull().$type<DimensionCatalog[]>(),
  measures: jsonb("measures").notNull().$type<MeasureCatalog[]>(),
  maxRowLimit: integer("max_row_limit").notNull().default(10000),
  drilldownUrlTemplate: text("drilldown_url_template"), // nullable; not all bases support drilldown
  // The MV columns the §4.7 D8 `reportable_scope` envelope narrows on. NULLABLE and nullable-by-default:
  // an org-grain MV (census, EVV-by-week) has no member or location column, and a narrowing scope on such
  // a base DENIES rather than serving the whole org (packages/reporting scope-injector, F-059). These are
  // platform-declared structural column names, never tenant input and never a selectable dimension.
  scopeMembershipColumn: text("scope_membership_column"),
  scopeLocationColumn: text("scope_location_column"),
  exposesPhiViaDrilldown: boolean("exposes_phi_via_drilldown").notNull().default(false),
  status: text("status", {
    enum: ["seeded", "active", "deprecated", "retired"],
  })
    .notNull()
    .default("seeded"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
});

export type ReportBaseCatalog = typeof reportBaseCatalog.$inferSelect;
export type NewReportBaseCatalog = typeof reportBaseCatalog.$inferInsert;
