// @chartwarden/db — `nppes_sync_coordination` (M40 MDM §3.5, §4.7.3). The single-row coordination
// state that lets the M40 nightly job (T08) act as a FALLBACK behind M29's platform NPPES sync
// (Wave H): it records when M29 last completed (run id + timestamp) and when the M40 legacy job
// last ran, so the nightly job can skip when M29 is fresh and fire after an M29 outage
// (§7.12/§7.13). Always exactly one row (`id` defaults to 1). Platform-operational, org-less
// (NON_ORG_SCOPED allowlist). RLS/audit land in M40-T03 (§3.6). Not PHI.
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const nppesSyncCoordination = pgTable("nppes_sync_coordination", {
  id: integer("id").primaryKey().default(1),
  lastM29SyncCompletedAt: timestamp("last_m29_sync_completed_at"),
  lastM29SyncRunId: text("last_m29_sync_run_id"),
  lastM40LegacyRunCompletedAt: timestamp("last_m40_legacy_run_completed_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type NppesSyncCoordination = typeof nppesSyncCoordination.$inferSelect;
export type NewNppesSyncCoordination = typeof nppesSyncCoordination.$inferInsert;
