// @chartwarden/reporting · scheduled — the scheduled-report RETENTION sweeper (M33 §2.2 / §3.3 retention class
// `operational`).
//
// `report_schedule_run` is PARTITIONED BY RANGE(scheduled_for) monthly, retention class `operational`: the
// per-occurrence run ledger (and its rendered-artifact back-ref) is operational telemetry, not a compliance
// record, so it ages out past the operational horizon. This sweeper selects TERMINAL occurrences (`delivered`
// / `failed`) whose `scheduled_for` is older than the horizon and archives them (the boot binds the archive
// effect — drop the aged monthly partition / release the run's M22 document reference; the destructive DDL is
// NOT this pure handler's concern, the same boundary as the EVV/audit partition-drop sweepers). A run still in
// flight (`queued`…`rendered_pending`) is NEVER archived — it has not reached a terminal state.
//
// PURE port-injected orchestration: {@link isPastRetentionHorizon} + {@link selectArchivableRuns} are total
// decision cores; {@link runScheduledRetention} is the thin injected-port orchestrator. No clock/Drizzle import.
import type { schema } from "@chartwarden/db";

/** §3.3: the `operational` retention horizon for `report_schedule_run` (90 days). The boot may override per
 *  the tenant's operational retention policy. */
export const SCHEDULED_RUN_OPERATIONAL_RETENTION_DAYS = 90 as const;

/** The terminal statuses a run must have reached to be eligible for the operational archive sweep. */
export const ARCHIVABLE_RUN_STATUSES: ReadonlySet<schema.ReportScheduleRun["status"]> = new Set([
  "delivered",
  "failed",
]);

/** The composite-PK handle the archive port settles a run by (the run id + its `scheduled_for` partition key). */
export interface ScheduledRunHandle {
  readonly runId: string;
  readonly scheduledFor: Date;
}

// ── pure decision cores ───────────────────────────────────────────────────────────────────────────────────

/** Whether a `scheduled_for` slot is older than the operational horizon counted back from `now` (PURE). */
export function isPastRetentionHorizon(
  scheduledFor: Date,
  now: Date,
  horizonDays: number = SCHEDULED_RUN_OPERATIONAL_RETENTION_DAYS,
): boolean {
  const cutoff = now.getTime() - horizonDays * 24 * 60 * 60 * 1000;
  return scheduledFor.getTime() < cutoff;
}

/**
 * Select the archivable occurrences from a candidate batch (PURE): TERMINAL (`delivered`/`failed`) runs whose
 * `scheduled_for` is past the operational horizon. An in-flight run is excluded even if its slot is old (it
 * has not settled). Returns the composite-PK handles the archive port drops.
 */
export function selectArchivableRuns(
  runs: readonly Pick<schema.ReportScheduleRun, "id" | "scheduledFor" | "status">[],
  now: Date,
  horizonDays: number = SCHEDULED_RUN_OPERATIONAL_RETENTION_DAYS,
): readonly ScheduledRunHandle[] {
  return runs
    .filter(
      (r) =>
        ARCHIVABLE_RUN_STATUSES.has(r.status) &&
        isPastRetentionHorizon(r.scheduledFor, now, horizonDays),
    )
    .map((r) => ({ runId: r.id, scheduledFor: r.scheduledFor }));
}

// ── injected ports ────────────────────────────────────────────────────────────────────────────────────────

/** Lists terminal occurrences with `scheduled_for < cutoff` (the boot binds this over the run repo, bounded
 *  by `limit` so the sweep is incremental). */
export interface RetentionListPort {
  listTerminalRunsBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly Pick<schema.ReportScheduleRun, "id" | "scheduledFor" | "status">[]>;
}

/** Archives one aged occurrence (release the M22 document reference / drop the aged partition leaf at boot). */
export interface RetentionArchivePort {
  archiveRun(handle: ScheduledRunHandle): Promise<void>;
}

/** The ports the retention sweeper composes over. */
export interface ScheduledRetentionPorts {
  readonly list: RetentionListPort;
  readonly archive: RetentionArchivePort;
  now(): Date;
}

/** What one retention sweep archived. */
export interface ScheduledRetentionReport {
  readonly sweptAt: string;
  readonly cutoff: string;
  readonly archived: readonly ScheduledRunHandle[];
}

/**
 * Run one operational-retention sweep (§3.3). Lists terminal occurrences past the horizon and archives each.
 * Thin — the horizon/terminal filter lives in the pure {@link selectArchivableRuns} (the list port pre-filters
 * by cutoff for index efficiency; the pure select re-checks for totality). Idempotent: a re-swept already-
 * archived run simply does not reappear in the next `listTerminalRunsBefore`.
 */
export async function runScheduledRetention(
  ports: ScheduledRetentionPorts,
  horizonDays: number = SCHEDULED_RUN_OPERATIONAL_RETENTION_DAYS,
  batchLimit = 500,
): Promise<ScheduledRetentionReport> {
  const now = ports.now();
  const cutoff = new Date(now.getTime() - horizonDays * 24 * 60 * 60 * 1000);
  const candidates = await ports.list.listTerminalRunsBefore(cutoff, batchLimit);
  const archivable = selectArchivableRuns(candidates, now, horizonDays);
  for (const handle of archivable) await ports.archive.archiveRun(handle);
  return { sweptAt: now.toISOString(), cutoff: cutoff.toISOString(), archived: archivable };
}
