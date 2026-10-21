// @chartwarden/reporting · scheduled — the scheduled-report RUNNER (M33 §2.2 / §2.5–§2.6 / §4.8 W-R-04).
//
// The body of the `report.scheduled_run` worker: it takes one due occurrence and drives it from `queued` to
// `rendered_pending` (the §2.2 ladder `queued → running → rendered_pending → rendered_complete → delivered`;
// the `rendered_*` flips land in delivery.ts on the M22 reply). Per W-R-04:
//   1. verify the schedule is still ACTIVE (a paused/cancelled schedule sinks the run to `failed`);
//   2. RE-VALIDATE every recipient's `reportable_scope` (defence in depth — a recipient may have lost access
//      between schedule creation and this run); drop the failures, audit `RECIPIENT_LOST_ACCESS`. If ZERO
//      recipients survive, auto-pause the schedule (`ALL_RECIPIENTS_REVOKED`), settle the run `failed`, emit
//      `m33.scheduled_report.failed`, and stop — nothing to render for nobody (§2.5);
//   3. build the snapshot query (the saved view's spec → SELECT on the read replica, `statement_timeout=300s`),
//      flip the run `running`, emit `m33.scheduled_report.render_requested` to M22 (the §1.1 render handshake,
//      `idempotencyKey = runId` for at-most-once render), and flip the run `rendered_pending`.
//
// IDEMPOTENT on `(schedule_id, scheduled_for)` (§2.6): the run row is created at-most-once by the cron
// evaluator's UNIQUE; a redelivered job whose run is already past `queued` is a no-op (`idempotent_skip`).
//
// PURE port-injected orchestration: every fact/effect is an injected port (no clock/RNG/Drizzle/BullMQ/M22/
// M39/translator import here). The {@link partitionRecipients} + {@link decideRunDisposition} decision cores
// are total functions unit-asserted independently of the I/O.
import type { schema } from "@chartwarden/db";
import type { RenderSnapshot, SnapshotColumn } from "../export/render-request";
import { M33_SCHEDULED_REPORT_AGGREGATE_TYPE } from "./delivery";

/** The reason string stamped on the run + emitted when a run auto-pauses for a fully-revoked recipient set. */
export const ALL_RECIPIENTS_REVOKED_REASON = "ALL_RECIPIENTS_REVOKED" as const;

// ── the `report.scheduled_run` job ────────────────────────────────────────────────────────────────────────

/** One `report.scheduled_run` job: the occurrence the cron evaluator enqueued (the run is already created). */
export interface ScheduledRunJob {
  readonly scheduleId: string;
  readonly runId: string;
  readonly organizationId: string;
  /** ISO-8601 — the `report_schedule_run` partition key + the §2.6 dedup component. */
  readonly scheduledFor: string;
}

// ── injected ports ────────────────────────────────────────────────────────────────────────────────────────

/** Reads the owning `report_schedule` (status + recipients + view + format). */
export interface RunnerScheduleReadPort {
  findById(scheduleId: string): Promise<schema.ReportSchedule | null>;
}

/** The run-ledger port (the partitioned `report_schedule_run`): read the current row + settle its status. */
export interface RunnerRunLedgerPort {
  findRun(runId: string, scheduledFor: Date): Promise<schema.ReportScheduleRun | null>;
  settle(
    runId: string,
    scheduledFor: Date,
    patch: Pick<
      schema.NewReportScheduleRun,
      "status" | "startedAt" | "finishedAt" | "failureReason" | "rowCount"
    >,
  ): Promise<void>;
}

/** Re-validates a recipient's `reportable_scope` (M39 `ConsentEvaluator.evaluateForReporting` / active
 *  membership). `true` = the recipient is still entitled to receive this view (the boot binds the real seam).
 *  GAP-097: `reportViewId` is the schedule's saved view — an implementation must also confirm the
 *  recipient may still SEE that view (a private view is not deliverable to a non-owner). */
export interface RecipientScopeValidationPort {
  isRecipientEntitled(
    membershipId: string,
    organizationId: string,
    reportViewId: string,
  ): Promise<boolean>;
}

/**
 * Compiles the view's saved spec → the parameterized snapshot SELECT AND EXECUTES it (translator on the
 * read replica). GAP-051: this used to return the query text alone, which M22 could not render from — it
 * has no reporting database and no params to bind, and the text carries literal `$1, $2, …` markers whose
 * values the translator deliberately keeps in a separate channel (D4). The port that owns the read session
 * is the one that must materialize, so it returns the rows too.
 */
export interface SnapshotQueryPort {
  build(input: {
    readonly reportViewId: string;
    readonly organizationId: string;
  }): Promise<{
    /** The executed SELECT, carried for PROVENANCE (what was rendered), not for execution downstream. */
    readonly snapshotQuery: string;
    readonly viewId: string;
    readonly viewName: string;
    /** The materialized result M22 renders (see {@link RenderSnapshot}). */
    readonly snapshot: RenderSnapshot;
  }>;
}

/** The §4.10 outbox emits the runner makes (render-request to M22; failure to M36). */
export interface RunnerOutboxPort {
  emitRenderRequested(payload: {
    readonly scheduleId: string;
    readonly runId: string;
    readonly viewId: string;
    readonly format: schema.ReportSchedule["format"];
    readonly organizationId: string;
    readonly snapshotQuery: string;
    readonly idempotencyKey: string;
    /**
     * GAP-051 — which of this wire name's TWO producers emitted, so M22 can resolve the right template
     * (and therefore the right `document_aggregate_type`). The ad-hoc export path sends `report_export`;
     * this one sends `report_schedule_run`, the aggregate `delivery.ts` already keys its back-ref on.
     */
    readonly aggregateType: typeof M33_SCHEDULED_REPORT_AGGREGATE_TYPE;
    /** The rendered document's title (the saved view's display name). */
    readonly title: string;
    /** The materialized snapshot M22 renders. */
    readonly columns: readonly SnapshotColumn[];
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
  }): Promise<void>;
  emitFailed(payload: {
    readonly scheduleId: string;
    readonly runId: string;
    readonly organizationId: string;
    readonly reason: string;
  }): Promise<void>;
}

/** Auto-pauses a schedule whose recipient set fully revoked (§2.5). The `report_schedule` table carries no
 *  `paused_reason` column, so the reason rides the emitted event + the audit row, not a DB field. */
export interface RunnerSchedulePausePort {
  autoPause(scheduleId: string, reason: string): Promise<void>;
}

/** The §164.528-style operational audit hooks (recipient access loss + full revocation). */
export interface RunnerAuditPort {
  recordRecipientLostAccess(scheduleId: string, membershipId: string): Promise<void>;
  recordAllRecipientsRevoked(scheduleId: string): Promise<void>;
}

/** The ports the runner composes over. */
export interface ScheduledRunPorts {
  readonly schedules: RunnerScheduleReadPort;
  readonly runs: RunnerRunLedgerPort;
  readonly recipients: RecipientScopeValidationPort;
  readonly snapshot: SnapshotQueryPort;
  readonly outbox: RunnerOutboxPort;
  readonly pause: RunnerSchedulePausePort;
  readonly audit: RunnerAuditPort;
  now(): Date;
}

// ── pure decision cores ───────────────────────────────────────────────────────────────────────────────────

/** One recipient's re-validation outcome. */
export interface RecipientValidity {
  readonly membershipId: string;
  readonly entitled: boolean;
}

/** Split a re-validated recipient list into the survivors (kept) and the dropped (lost-access) sets (PURE). */
export function partitionRecipients(validities: readonly RecipientValidity[]): {
  readonly survivors: readonly string[];
  readonly dropped: readonly string[];
} {
  const survivors: string[] = [];
  const dropped: string[] = [];
  for (const v of validities) (v.entitled ? survivors : dropped).push(v.membershipId);
  return { survivors, dropped };
}

/** The run's disposition after schedule + recipient checks. */
export type RunDisposition =
  /** The schedule is not active (paused/cancelled) — the run cannot proceed. */
  | { readonly kind: "schedule_inactive"; readonly status: schema.ReportSchedule["status"] }
  /** Every recipient revoked — auto-pause + fail (§2.5). */
  | { readonly kind: "all_revoked" }
  /** Render for the surviving recipients (the happy path). */
  | { readonly kind: "proceed"; readonly survivors: readonly string[] };

/**
 * Decide the run disposition from the schedule status + the surviving recipient set (PURE). Gate order:
 * schedule-active → at-least-one-survivor → proceed. Total over the three outcomes.
 */
export function decideRunDisposition(
  schedule: Pick<schema.ReportSchedule, "status">,
  survivors: readonly string[],
): RunDisposition {
  if (schedule.status !== "active") return { kind: "schedule_inactive", status: schedule.status };
  if (survivors.length === 0) return { kind: "all_revoked" };
  return { kind: "proceed", survivors };
}

// ── the orchestrator ──────────────────────────────────────────────────────────────────────────────────────

/** What one `handleScheduledRun` reported. */
export type ScheduledRunResult =
  /** A redelivery whose run was already past `queued` — no-op (§2.6 idempotency). */
  | { readonly kind: "idempotent_skip"; readonly status: schema.ReportScheduleRun["status"] }
  /** The schedule was gone or inactive — run settled `failed`. */
  | { readonly kind: "failed"; readonly reason: string }
  /** Every recipient revoked — schedule auto-paused, run settled `failed`. */
  | { readonly kind: "all_recipients_revoked" }
  /** Render requested from M22; run is `rendered_pending` awaiting the reply. */
  | { readonly kind: "render_requested"; readonly recipientCount: number };

/** Raised when the job names a `report_schedule_run` that does not exist (the evaluator must create it first). */
export class ScheduledRunMissing extends Error {
  constructor(runId: string, scheduledFor: string) {
    super(
      `report_schedule_run ${runId}@${scheduledFor} not found — the cron evaluator must create it first`,
    );
    this.name = "ScheduledRunMissing";
  }
}

/**
 * Handle one `report.scheduled_run` job (§2.2 / W-R-04). Idempotent on the run's state: a run already past
 * `queued` is a no-op. Drives a fresh run through schedule-active + recipient re-validation, then either
 * auto-pauses (all revoked) or requests the M22 render and parks the run at `rendered_pending`. Thin — the
 * gating lives in the pure deciders; every effect is an injected port.
 *
 * @throws {ScheduledRunMissing} the occurrence row does not exist
 */
export async function handleScheduledRun(
  job: ScheduledRunJob,
  ports: ScheduledRunPorts,
): Promise<ScheduledRunResult> {
  const scheduledFor = new Date(job.scheduledFor);

  const run = await ports.runs.findRun(job.runId, scheduledFor);
  if (run === null) throw new ScheduledRunMissing(job.runId, job.scheduledFor);
  // §2.6 idempotency: a redelivery whose run already advanced past `queued` is a no-op.
  if (run.status !== "queued") return { kind: "idempotent_skip", status: run.status };

  const schedule = await ports.schedules.findById(job.scheduleId);
  if (schedule === null) {
    const reason = "schedule_absent";
    await ports.runs.settle(job.runId, scheduledFor, {
      status: "failed",
      finishedAt: ports.now(),
      failureReason: reason,
    });
    await ports.outbox.emitFailed({
      scheduleId: job.scheduleId,
      runId: job.runId,
      organizationId: job.organizationId,
      reason,
    });
    return { kind: "failed", reason };
  }

  // Re-validate each recipient's reportable_scope (defence in depth, W-R-04). Drop + audit the failures.
  const validities: RecipientValidity[] = [];
  for (const membershipId of schedule.recipientMembershipIds) {
    const entitled = await ports.recipients.isRecipientEntitled(
      membershipId,
      job.organizationId,
      schedule.reportViewId,
    );
    validities.push({ membershipId, entitled });
    if (!entitled) await ports.audit.recordRecipientLostAccess(job.scheduleId, membershipId);
  }
  const { survivors } = partitionRecipients(validities);

  const disposition = decideRunDisposition(schedule, survivors);

  if (disposition.kind === "schedule_inactive") {
    const reason = `schedule_${disposition.status}`;
    await ports.runs.settle(job.runId, scheduledFor, {
      status: "failed",
      finishedAt: ports.now(),
      failureReason: reason,
    });
    await ports.outbox.emitFailed({
      scheduleId: job.scheduleId,
      runId: job.runId,
      organizationId: job.organizationId,
      reason,
    });
    return { kind: "failed", reason };
  }

  if (disposition.kind === "all_revoked") {
    await ports.audit.recordAllRecipientsRevoked(job.scheduleId);
    await ports.pause.autoPause(job.scheduleId, ALL_RECIPIENTS_REVOKED_REASON);
    await ports.runs.settle(job.runId, scheduledFor, {
      status: "failed",
      finishedAt: ports.now(),
      failureReason: ALL_RECIPIENTS_REVOKED_REASON,
    });
    await ports.outbox.emitFailed({
      scheduleId: job.scheduleId,
      runId: job.runId,
      organizationId: job.organizationId,
      reason: ALL_RECIPIENTS_REVOKED_REASON,
    });
    return { kind: "all_recipients_revoked" };
  }

  // proceed: run → running, build the snapshot, request the M22 render, park at rendered_pending.
  await ports.runs.settle(job.runId, scheduledFor, { status: "running", startedAt: ports.now() });

  const { snapshotQuery, viewId, viewName, snapshot } = await ports.snapshot.build({
    reportViewId: schedule.reportViewId,
    organizationId: job.organizationId,
  });

  // The §1.1 render handshake: M22 renders the snapshot (PDF/XLSX; CSV is delivered as a stored artifact too)
  // and replies `m22.document.rendered` keyed by `runId`; delivery.ts writes the document back. The
  // idempotencyKey = runId gives M22 at-most-once render across a redelivered request. The snapshot travels
  // WITH the request (GAP-051) — M22 renders content, it does not run M33's SQL.
  await ports.outbox.emitRenderRequested({
    scheduleId: job.scheduleId,
    runId: job.runId,
    viewId,
    format: schedule.format,
    organizationId: job.organizationId,
    snapshotQuery,
    idempotencyKey: job.runId,
    aggregateType: M33_SCHEDULED_REPORT_AGGREGATE_TYPE,
    title: viewName,
    columns: snapshot.columns,
    rows: snapshot.rows,
    rowCount: snapshot.rowCount,
  });

  await ports.runs.settle(job.runId, scheduledFor, { status: "rendered_pending" });
  return { kind: "render_requested", recipientCount: disposition.survivors.length };
}
