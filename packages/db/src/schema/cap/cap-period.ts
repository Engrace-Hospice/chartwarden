// @chartwarden/db — M26 Cap Management §3.3 — the cap-period root cluster: the PLATFORM-scoped published cap
// constant + the per-tenant cap_period lifecycle row + its one-time methodology lock.
//
// Tenancy (ADR-0010, canonical): cap_period + cap_period_methodology_lock carry organization_id NOT NULL →
// the canonical app.org_id RLS predicate. cap_period_platform_constant is PLATFORM-SHARED (no org column,
// like wage_index_factor / cost_report_validation_rule) — it lives on the check-tenancy NON_ORG_SCOPED
// allowlist with read-all USING(true) + permission-gated writes. The cap_period EXCLUDE no-overlap
// constraint (btree_gist) lands in the SQL migration (Drizzle has no first-class EXCLUDE syntax).
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id → organization and intra-M26
// non-partitioned parents are real FKs. opened_by / closed_by / settled_by / recorded_by / locked_by /
// step_up_session_id (M2) are LOGICAL uuid. cap_year is a soft FK to cap_period_platform_constant.
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m26Methodology, m26PeriodStatus } from "./enums";

// ---- cap_period_platform_constant — PLATFORM-scoped; one row per cap year (e.g. 'FY2026') ----
export const capPeriodPlatformConstant = pgTable("cap_period_platform_constant", {
  capYear: varchar("cap_year", { length: 7 }).primaryKey(), // 'FY2026'
  aggregateCapAmountCents: bigint("aggregate_cap_amount_cents", { mode: "number" }), // nullable: published mid-summer
  inpatientCapPct: numeric("inpatient_cap_pct", { precision: 5, scale: 4 })
    .notNull()
    .default("0.2000"),
  sourceUrl: text("source_url"),
  sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
  recordedBy: uuid("recorded_by").notNull(), // M2 platform admin (logical)
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  firstTenantUseAt: timestamp("first_tenant_use_at", { withTimezone: true }), // null until first cap_period opens against it
});

// ---- cap_period — per-tenant, per-cap-year lifecycle root ----
export const capPeriod = pgTable(
  "cap_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ccn: char("ccn", { length: 6 }).notNull(), // canonical CCN from M40
    capYear: varchar("cap_year", { length: 7 }).notNull(), // soft FK → cap_period_platform_constant
    startsOn: date("starts_on").notNull(), // Oct 1
    endsOn: date("ends_on").notNull(), // Sep 30
    aggregateCapAmountCents: bigint("aggregate_cap_amount_cents", { mode: "number" }).notNull(), // snapshot of platform constant
    inpatientCapPct: numeric("inpatient_cap_pct", { precision: 5, scale: 4 }).notNull(),
    methodology: m26Methodology("methodology"), // nullable until locked
    status: m26PeriodStatus("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedBy: uuid("opened_by").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    settledBy: uuid("settled_by"),
    graceWindowDays: smallint("grace_window_days").notNull().default(30),
    notes: text("notes"),
  },
  (t) => ({
    uniqOrgCcnYear: unique("cap_period_org_ccn_year_uq").on(t.organizationId, t.ccn, t.capYear),
    ckWindow: check("cap_period_window_ck", sql`${t.endsOn} > ${t.startsOn}`),
    ckGrace: check("cap_period_grace_ck", sql`${t.graceWindowDays} BETWEEN 0 AND 90`),
    // EXCLUDE USING gist (organization_id =, ccn =, daterange(starts_on,ends_on,'[]') &&) added in migration.
  }),
);

// ---- cap_period_methodology_lock — 1:1 with cap_period; the one-time, step-up-gated methodology choice ----
export const capPeriodMethodologyLock = pgTable("cap_period_methodology_lock", {
  capPeriodId: uuid("cap_period_id")
    .primaryKey()
    .references(() => capPeriod.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  methodology: m26Methodology("methodology").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  lockedBy: uuid("locked_by").notNull(),
  reason: text("reason").notNull(),
  stepUpSessionId: uuid("step_up_session_id").notNull(), // M2 step-up evidence per D12 (logical)
});
