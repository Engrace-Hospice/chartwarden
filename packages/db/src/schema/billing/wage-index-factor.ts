// @wardenx/db — `wage_index_factor` (M23 Billing-Medicare §3.3, D12; non-partitioned; retention class
// `reference`). The CMS per-CCN wage-index schedule consumed by HIPPS math (snapshotted onto
// hipps_calculation at calculation time so the math is reproducible).
//
// PLATFORM-SHARED (no organization_id): this is the ONLY M23 table with NO organization_id column and
// NO `.references(() => organizations.id)`. It must be added to the check-tenancy NON_ORG_SCOPED
// allowlist. RLS is SELECT-only `USING (true)` for app_user + full-CRUD for the platform_loader role;
// the migration (§3.2 Phase D) MUST `REVOKE INSERT` on this table from app_user so only platform_loader
// can load CMS rate files. Mirrors the M27 `cost_report_validation_rule` NON_ORG_SCOPED precedent
// (but unlike M27 there is no nullable-org variant — this table is purely platform-owned). No PHI (D18).
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const wageIndexFactor = pgTable(
  "wage_index_factor",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    ccn: text("ccn").notNull(), // 6-char CMS CCN
    fiscalYearStarting: integer("fiscal_year_starting").notNull(), // e.g. 2026 for FY2026 (Oct 1, 2025–Sep 30, 2026)
    cbsaCode: text("cbsa_code"), // optional — some CCNs are non-CBSA
    factorDecimal: text("factor_decimal").notNull(), // e.g. "0.9234"

    loadSourceRef: text("load_source_ref").notNull(), // CMS file URI loaded from
    /** F-211 (0280): false = a non-authoritative placeholder/fixture row; claim assembly never prices from one. */
    isAuthoritative: boolean("is_authoritative").notNull().default(true),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueByCcnFy: uniqueIndex("wage_index_factor_ccn_fy_uq").on(t.ccn, t.fiscalYearStarting),
    byFy: index("wage_index_factor_fy_idx").on(t.fiscalYearStarting),
  }),
);

export type WageIndexFactor = typeof wageIndexFactor.$inferSelect;
export type NewWageIndexFactor = typeof wageIndexFactor.$inferInsert;
