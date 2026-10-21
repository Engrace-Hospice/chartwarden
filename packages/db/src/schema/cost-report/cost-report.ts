// @chartwarden/db — `cost_report` (M27 §3.3, D1; non-partitioned; retention class `compliance`).
// The regulatory-financial-record root: one row per (provider_entity, fiscal-year-end). Composite
// uniqueness `(organization_id, provider_entity_id, fiscal_year_end_date)` enforces one CMS-1984-14
// report per CCN per FY (D1). The XState lifecycle (D4) lives in `state`. ORG-SCOPED: organization_id
// NOT NULL (canonical app.org_id RLS). provider_entity_id is a logical FK to M40; latest_snapshot_id is
// a logical ref to cost_report_snapshot (the cross-table FK lands in migration phase 3, DEFERRABLE).
// No PHI (D18) — aggregate financial/statistical only.
import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const m27CostReportState = pgEnum("m27_cost_report_state", [
  "draft",
  "populating",
  "validating",
  "ready_for_review",
  "approved_for_submit",
  "submitted",
  "accepted",
  "rejected",
  "reopened",
  "closed",
]);

export const m27WageSource = pgEnum("m27_wage_source", ["gusto", "manual"]);

export const costReport = pgTable(
  "cost_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    fiscalYearStartDate: date("fiscal_year_start_date").notNull(),
    fiscalYearEndDate: date("fiscal_year_end_date").notNull(),
    state: m27CostReportState("state").notNull().default("draft"),
    reopenCount: integer("reopen_count").notNull().default(0),
    latestSnapshotId: uuid("latest_snapshot_id"),
    badDebtClaimed: boolean("bad_debt_claimed").notNull().default(false),
    wageSource: m27WageSource("wage_source").notNull().default("manual"),
    deadlineExtensionUntilDate: date("deadline_extension_until_date"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // GAP-081 two-person control: stamped server-side at approve_for_submit (the authenticated actor),
    // compared at submit, cleared on return-to-draft / reopen. NULL on reports approved pre-0331 (submit refuses).
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => ({
    uniqProviderFye: unique("uniq_cost_report_provider_fye").on(
      t.organizationId,
      t.providerEntityId,
      t.fiscalYearEndDate,
    ),
    idxOrgState: index("idx_cost_report_org_state").on(t.organizationId, t.state),
    idxProviderEntityFye: index("idx_cost_report_provider_fye_date").on(
      t.providerEntityId,
      t.fiscalYearEndDate,
    ),
  }),
);

export type CostReport = typeof costReport.$inferSelect;
export type NewCostReport = typeof costReport.$inferInsert;
