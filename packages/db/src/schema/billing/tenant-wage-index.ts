import { sql } from "drizzle-orm";
// @wardenx/db — `tenant_wage_index` (M23 Billing-Medicare; F-211, migration 0280). The TENANT-ENTERED, append-only CMS
// hospice wage index for a CCN + federal fiscal year. ORG-SCOPED (organization_id NOT NULL, canonical app.org_id RLS,
// ENABLED + FORCED). No PHI.
//
// Why not write into the platform-shared `wage_index_factor`: that table has NO organization_id (D12) and `wardenx_app`
// holds SELECT only — a tenant-keyed value there would silently reprice every tenant. Claim assembly reads this table
// first, then a platform AUTHORITATIVE `wage_index_factor` row.
//
// APPEND-ONLY: a correction SUPERSEDES a row (`superseded_at` + `superseded_by_id`, the only app-updatable columns —
// column GRANT + `tenant_wage_index_guard` trigger). At most one LIVE row per (org, ccn, fiscal year): the partial unique
// index `tenant_wage_index_live_uq` (a partial index is SQL-migration-only for drizzle).
// The factor is `numeric(6,4)` inside a CHECK band 0.5..2.5, surfaced as a decimal STRING (never a float).
import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantWageIndex = pgTable(
  "tenant_wage_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ccn: text("ccn").notNull(), // 6-char CMS Certification Number
    /** The federal fiscal year's STARTING calendar year (Oct 1): 2025 = FY2026 (Oct 2025 - Sep 2026). */
    fiscalYearStarting: integer("fiscal_year_starting").notNull(),
    cbsaCode: text("cbsa_code"), // optional 5-digit CBSA the index was published for
    factorDecimal: numeric("factor_decimal", { precision: 6, scale: 4 }).notNull(),
    /** Where the keyed value came from (e.g. the CMS wage-index table / Federal Register citation). Required. */
    sourceReference: text("source_reference").notNull(),
    enteredByMembershipId: uuid("entered_by_membership_id").notNull(), // logical FK → memberships
    entryReason: text("entry_reason"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookup: index("tenant_wage_index_lookup_idx").on(
      t.organizationId,
      t.ccn,
      t.fiscalYearStarting,
      sql`${t.createdAt} DESC`,
    ),
  }),
);

export type TenantWageIndex = typeof tenantWageIndex.$inferSelect;
export type NewTenantWageIndex = typeof tenantWageIndex.$inferInsert;
