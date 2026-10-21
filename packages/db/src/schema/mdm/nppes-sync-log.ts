// @chartwarden/db — `nppes_sync_log` (M40 MDM §3.5, §4.3). The append-only run record for each
// NPPES sync — mode (nightly_delta/weekly_full/on_demand), counters (looked-up/changed/
// deactivated/errors), and outcome. The nightly delta is the Phase-1 authoritative sync path
// (M40-T08); this log is what §7.5 drift detection and §7.12/§7.13 fallback reasoning read.
// Platform-operational, org-less (NON_ORG_SCOPED allowlist). RLS/audit land in M40-T03 (§3.6).
// Not PHI.
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { mdmNppesSyncMode } from "../../enums";

export const nppesSyncLog = pgTable(
  "nppes_sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    mode: mdmNppesSyncMode("mode").notNull(),
    lookedUp: integer("looked_up").notNull().default(0),
    changed: integer("changed").notNull().default(0),
    deactivated: integer("deactivated").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    outcome: text("outcome").notNull(), // 'success'|'partial'|'failed'
    errorSummary: jsonb("error_summary"),
  },
  (t) => ({
    runAtIdx: index("nppes_sync_log_run_at_idx").on(t.runAt),
  }),
);

export type NppesSyncLog = typeof nppesSyncLog.$inferSelect;
export type NewNppesSyncLog = typeof nppesSyncLog.$inferInsert;
