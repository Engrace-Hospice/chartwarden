// @wardenx/reporting · repositories — the run-ledger aggregate: `report_schedule_run` (the per-
// occurrence ledger for a scheduled report, partitioned monthly by `scheduled_for`) + `report_run`
// (the MV-refresh ledger, partitioned monthly by `started_at`, nullable org for cross-tenant refreshes)
// (M33 §3.3–§3.4). Both carry a COMPOSITE PK (id + partition key), so point reads take BOTH the id and
// the partition-key value (partition pruning). The schedule-runner / MV-refresh workers wrap these in
// `withOrgContext` / `withPlatformContext`.
import { schema } from "@wardenx/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ReportingDb } from "./db";

const SR = schema.reportScheduleRun;
const RR = schema.reportRun;

/**
 * One raw row back from `report_writer_insert_platform_report_run` / `..._update_platform_report_run`
 * (`SELECT * FROM fn(...)` unnests the composite `report_run` return type into its own columns).
 *
 * Timestamps come back as STRINGS, not `Date` objects: `db.execute(sql\`...\`)` is a raw/untyped query,
 * so Drizzle's `PgTimestamp.mapFromDriverValue` conversion (which normal typed `.select()`/`.insert()`
 * calls get automatically) never runs — the pg driver hands back whatever its (Drizzle-configured) type
 * parser produces for `timestamptz`, which is a plain string here. `fromPlatformRow` below does the
 * string→Date conversion explicitly.
 */
interface RawPlatformReportRunRow {
  id: string;
  mv_key: string;
  organization_id: string | null;
  trigger_kind: schema.ReportRun["triggerKind"];
  trigger_outbox_event_id: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  rows_affected: number | null;
  status: schema.ReportRun["status"];
  failure_reason: string | null;
  retry_attempt: number;
}

function fromPlatformRow(row: RawPlatformReportRunRow): schema.ReportRun {
  return {
    id: row.id,
    mvKey: row.mv_key,
    organizationId: row.organization_id,
    triggerKind: row.trigger_kind,
    triggerOutboxEventId: row.trigger_outbox_event_id,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
    durationMs: row.duration_ms,
    rowsAffected: row.rows_affected,
    status: row.status,
    failureReason: row.failure_reason,
    retryAttempt: row.retry_attempt,
  };
}

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

  /**
   * Insert an MV-refresh row (defaults to `queued`). Returns the inserted row.
   *
   * A NULL `organizationId` (a genuinely platform-wide refresh — no single tenant it belongs to)
   * does NOT go through the plain Drizzle insert below: `wardenx_app` has no RLS policy admitting an
   * `organization_id IS NULL` row (WX-PR-024 — same ADR-0010 D2/D3 reasoning `outbox_event`'s
   * migration 0186 already documents). It calls the SECURITY DEFINER
   * `report_writer_insert_platform_report_run` function instead (migration 0188) — owned by
   * `report_writer`, EXECUTE granted directly to `wardenx_app`, touches `organization_id IS NULL` rows
   * only (hardcoded in the function body, never a caller-supplied parameter).
   */
  async createMvRun(values: schema.NewReportRun): Promise<schema.ReportRun> {
    if (values.organizationId === null || values.organizationId === undefined) {
      const result = await this.db.execute(sql`
        SELECT * FROM report_writer_insert_platform_report_run(
          ${values.id},
          ${values.mvKey},
          ${values.triggerKind},
          ${values.triggerOutboxEventId ?? null},
          ${values.startedAt},
          ${values.status ?? "queued"},
          ${values.retryAttempt ?? 0}
        )
      `);
      const row = (result as unknown as { rows: RawPlatformReportRunRow[] }).rows[0];
      if (!row) throw new Error("report_run platform-wide insert returned no row");
      return fromPlatformRow(row);
    }
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
   *
   * This method doesn't know the row's `organizationId` up front (the caller only has the `(id,
   * startedAt)` handle `createMvRun`/`open` returned), so it tries the plain, RLS-covered
   * `wardenx_app` UPDATE first — the only shape that can ever match an ORG-SCOPED row. A
   * platform-wide (`organization_id IS NULL`) row can never satisfy `report_run_org`'s
   * `organization_id = current_setting('app.org_id', true)::uuid` predicate (WX-PR-024), so that
   * UPDATE silently matches zero rows for one; the fallback then calls the SECURITY DEFINER
   * `report_writer_update_platform_report_run` function (migration 0188), which scopes explicitly to
   * `organization_id IS NULL` and raises if the row genuinely doesn't exist there either.
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
    if (row) return row;

    const result = await this.db.execute(sql`
      SELECT * FROM report_writer_update_platform_report_run(
        ${id},
        ${startedAt},
        ${JSON.stringify(patch)}::jsonb
      )
    `);
    const platformRow = (result as unknown as { rows: RawPlatformReportRunRow[] }).rows[0];
    if (!platformRow) throw new Error(`report_run ${id}@${startedAt.toISOString()} not found`);
    return fromPlatformRow(platformRow);
  }
}
