// @wardenx/db — `cost_center_mapping` (M27 §3.3, D5; non-partitioned; retention class `operational`).
// Per-(tenant, provider_entity, fiscal_year) GL-account → CMS-1984-14 cost-center mapping. Platform
// defaults are seeded; tenant overrides/extensions layer on top. Versioned per FY so a 2027 re-mapping
// does not retroactively alter the 2026 cost report. UNIQUE per (org, provider, fy, xero_account_code) —
// no double-mapping of a single GL account in a single FY. cms_cost_center_code is an M38 value-set
// member (`cms_cost_center_v1984_14`). ORG-SCOPED. No PHI (D18).
import { index, integer, pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const m27MappingSource = pgEnum("m27_mapping_source", [
  "platform_default",
  "tenant_override",
  "tenant_extended",
]);

export const costCenterMapping = pgTable(
  "cost_center_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    fiscalYearInt: integer("fiscal_year_int").notNull(), // e.g. 2026 for FYE 2026-12-31
    xeroAccountCode: varchar("xero_account_code", { length: 50 }).notNull(),
    xeroAccountName: varchar("xero_account_name", { length: 200 }).notNull(),
    cmsCostCenterCode: varchar("cms_cost_center_code", { length: 50 }).notNull(),
    mappingSource: m27MappingSource("mapping_source").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOrgProviderFyAccount: unique("uniq_mapping_org_provider_fy_account").on(
      t.organizationId,
      t.providerEntityId,
      t.fiscalYearInt,
      t.xeroAccountCode,
    ),
    idxOrgProviderFy: index("idx_mapping_org_provider_fy").on(
      t.organizationId,
      t.providerEntityId,
      t.fiscalYearInt,
    ),
  }),
);

export type CostCenterMapping = typeof costCenterMapping.$inferSelect;
export type NewCostCenterMapping = typeof costCenterMapping.$inferInsert;
