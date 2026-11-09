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

/** The composite-PK handle the archive port settles a run by (the run id + its `scheduled_for` partition key). */
export interface ScheduledRunHandle {
  readonly runId: string;
  readonly scheduledFor: Date;
}

// ── pure decision cores ───────────────────────────────────────────────────────────────────────────────────

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
