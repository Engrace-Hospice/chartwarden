// @wardenx/reporting · repositories — the run-ledger aggregate: `report_schedule_run` (the per-
// occurrence ledger for a scheduled report, partitioned monthly by `scheduled_for`) + `report_run`
// (the MV-refresh ledger, partitioned monthly by `started_at`, nullable org for cross-tenant refreshes)
// (M33 §3.3–§3.4). Both carry a COMPOSITE PK (id + partition key), so point reads take BOTH the id and
// the partition-key value (partition pruning). The schedule-runner / MV-refresh workers wrap these in
// `withOrgContext` / `withPlatformContext`.
import { schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";
import type { ReportingDb } from "./db";

const SR = schema.reportScheduleRun;
const RR = schema.reportRun;

/** Data port for the two partitioned run ledgers. */
export class ReportRunRepository {
  constructor(private readonly db: ReportingDb) {}

  // ── report_schedule_run (scheduled-report occurrence ledger) ─────────────────────────────────

  /** Insert a scheduled-report occurrence row (defaults to `queued`). Returns the inserted row. */
  async createScheduleRun(values: schema.NewReportScheduleRun): Promise<schema.ReportScheduleRun> {
    const [row] = await this.db.insert(SR).values(values).returning();
    if (!row) throw new Error("report_schedule_run insert returned no row");
    return row;
  }

  /** Point read by the composite PK (id + scheduled_for, the partition key), or `null`. */
  async findScheduleRunById(
    id: string,
    scheduledFor: Date,
  ): Promise<schema.ReportScheduleRun | null> {
    const [row] = await this.db
      .select()
      .from(SR)
      .where(and(eq(SR.id, id), eq(SR.scheduledFor, scheduledFor)))
      .limit(1);
    return row ?? null;
  }

  /** A schedule's occurrence ledger newest-first (§3.4 `..._schedule_scheduled_for_idx`). */
  async listScheduleRuns(
    scheduleId: string,
    limit = 50,
  ): Promise<readonly schema.ReportScheduleRun[]> {
    return this.db
      .select()
      .from(SR)
      .where(eq(SR.scheduleId, scheduleId))
      .orderBy(desc(SR.scheduledFor))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /** The operations worklist (§3.4 `report_schedule_run_status_org_idx`): runs by status in an org. */
  async listScheduleRunsByStatus(
    organizationId: string,
    status: schema.ReportScheduleRun["status"],
    limit = 100,
  ): Promise<readonly schema.ReportScheduleRun[]> {
    return this.db
      .select()
      .from(SR)
      .where(and(eq(SR.status, status), eq(SR.organizationId, organizationId)))
      .orderBy(desc(SR.scheduledFor))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /**
   * Transition a scheduled-run row (queued → running → rendered_* → delivered / failed), stamping the
   * lifecycle timestamps + M22 document back-ref + telemetry. Scoped by the composite PK.
   */
  async updateScheduleRunStatus(
    id: string,
    scheduledFor: Date,
    patch: Partial<
      Pick<
        schema.NewReportScheduleRun,
        "status" | "startedAt" | "finishedAt" | "documentId" | "failureReason" | "rowCount"
      >
    >,
  ): Promise<schema.ReportScheduleRun> {
    const [row] = await this.db
      .update(SR)
      .set(patch)
      .where(and(eq(SR.id, id), eq(SR.scheduledFor, scheduledFor)))
      .returning();
    if (!row) throw new Error(`report_schedule_run ${id}@${scheduledFor.toISOString()} not found`);
    return row;
  }

  // ── report_run (MV-refresh ledger) ───────────────────────────────────────────────────────────

  /** Insert an MV-refresh row (defaults to `queued`). Returns the inserted row. */
  async createMvRun(values: schema.NewReportRun): Promise<schema.ReportRun> {
    const [row] = await this.db.insert(RR).values(values).returning();
    if (!row) throw new Error("report_run insert returned no row");
    return row;
  }

  /** Point read by the composite PK (id + started_at, the partition key), or `null`. */
  async findMvRunById(id: string, startedAt: Date): Promise<schema.ReportRun | null> {
    const [row] = await this.db
      .select()
      .from(RR)
      .where(and(eq(RR.id, id), eq(RR.startedAt, startedAt)))
      .limit(1);
    return row ?? null;
  }

  /** The most-recent refresh for an MV (§3.4 `report_run_mv_key_status_started_idx`), or `null`. */
  async findLastRunForMv(mvKey: string): Promise<schema.ReportRun | null> {
    const [row] = await this.db
      .select()
      .from(RR)
      .where(eq(RR.mvKey, mvKey))
      .orderBy(desc(RR.startedAt))
      .limit(1);
    return row ?? null;
  }

  /** The failure-worklist (§3.4 partial `report_run_status_started_idx` WHERE status='failed'). */
  async listFailedMvRuns(limit = 100): Promise<readonly schema.ReportRun[]> {
    return this.db
      .select()
      .from(RR)
      .where(eq(RR.status, "failed"))
      .orderBy(desc(RR.startedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /**
   * Transition an MV-refresh row (queued → running → succeeded / failed), stamping finish telemetry +
   * retry attempt. Scoped by the composite PK.
   */
  async updateMvRunStatus(
    id: string,
    startedAt: Date,
    patch: Partial<
      Pick<
        schema.NewReportRun,
        "status" | "finishedAt" | "durationMs" | "rowsAffected" | "failureReason" | "retryAttempt"
      >
    >,
  ): Promise<schema.ReportRun> {
    const [row] = await this.db
      .update(RR)
      .set(patch)
      .where(and(eq(RR.id, id), eq(RR.startedAt, startedAt)))
      .returning();
    if (!row) throw new Error(`report_run ${id}@${startedAt.toISOString()} not found`);
    return row;
  }
}
