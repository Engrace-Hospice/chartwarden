// @wardenx/reporting · scheduled — the scheduled-report CRON EVALUATOR (M33 §2.3 / §2.5–§2.6 / §4.8 W-R-04).
//
// The tick brain for the `report.scheduled_run` queue. The boot scheduler fires this every cron cadence; the
// handler walks the ACTIVE `report_schedule` rows whose `next_run_at <= now` (the §3.4
// `(organization_id, status, next_run_at)` index), and for each due schedule:
//   1. enqueues ONE `report.scheduled_run` job for the due `scheduled_for` slot — AT-MOST-ONCE per
//      `(schedule_id, scheduled_for)` (the §3.4 per-leaf UNIQUE on `report_schedule_run` is the dedup oracle;
//      a redelivered tick collapses onto the same occurrence rather than double-rendering, §2.6);
//   2. advances `next_run_at` to the cron's next fire (evaluated against the schedule's IANA
//      `tenant_timezone`), so a failed run does NOT block future runs (§2.5).
// A schedule whose cron yields < 5 min between successive fires is rejected (`CRON_TOO_FREQUENT`, §2.3) — no
// run is enqueued, but `next_run_at` still advances so the evaluator makes forward progress.
//
// PURE port-injected orchestration (the M34 worker precedent): no clock/RNG/Drizzle/BullMQ/cron-library
// import here. Cron math is the injected {@link CronSchedulePort} (the boot binds `cron-parser` over the
// tenant TZ); the due-set + enqueue + advance are injected ports. The {@link decideScheduleFire} +
// {@link isCadenceTooFrequent} decision cores are total functions unit-asserted independently of I/O.
import type { schema } from "@wardenx/db";

/** §2.3: the minimum gap a schedule's cron must leave between successive fires (5 min). */
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;

// ── injected ports ────────────────────────────────────────────────────────────────────────────────────────

/** Lists the schedules due at `now` (active + `next_run_at <= now`). The boot binds this over
 *  `ReportScheduleRepository.listDue` under `withPlatformContext` (the cross-org cron scan, §3.4). */
export interface ScheduleDueListPort {
  listDue(now: Date): Promise<readonly schema.ReportSchedule[]>;
}

/** Cron + timezone math (the injected `cron-parser`-over-IANA-TZ primitive; keeps the handler pure). */
export interface CronSchedulePort {
  /** The next fire STRICTLY after `after`, evaluated in the schedule's IANA `tenantTimezone`. */
  nextRunAfter(cronExpression: string, tenantTimezone: string, after: Date): Date;
}

/** The fields one due occurrence enqueues with. */
export interface ScheduleRunEnqueueInput {
  readonly scheduleId: string;
  readonly organizationId: string;
  readonly reportViewId: string;
  readonly format: schema.ReportSchedule["format"];
  /** The due slot — the `report_schedule_run` partition key + the §2.6 at-most-once dedup component. */
  readonly scheduledFor: Date;
}

/** Creates the `report_schedule_run` occurrence (at-most-once on the §3.4 UNIQUE) + enqueues the
 *  `report.scheduled_run` job. `enqueued=false` = an idempotent collapse onto an existing occurrence. */
export interface ScheduleRunEnqueuePort {
  enqueueRun(
    input: ScheduleRunEnqueueInput,
  ): Promise<{ readonly enqueued: boolean; readonly runId: string | null }>;
}

/** Advances `report_schedule.next_run_at` to the cron's next fire (so the schedule keeps ticking). */
export interface ScheduleAdvancePort {
  advanceNextRun(scheduleId: string, nextRunAt: Date): Promise<void>;
}

/** Records the §2.3 `CRON_TOO_FREQUENT` rejection for ops visibility (optional — best-effort audit). */
export interface CronCadenceAuditPort {
  recordCronTooFrequent(scheduleId: string, gapSeconds: number): Promise<void>;
}

/** The ports the cron evaluator composes over: the due-set + cron math + enqueue + advance + a clock. */
export interface CronEvaluatorPorts {
  readonly schedules: ScheduleDueListPort;
  readonly cron: CronSchedulePort;
  readonly enqueue: ScheduleRunEnqueuePort;
  readonly advance: ScheduleAdvancePort;
  readonly audit?: CronCadenceAuditPort;
  now(): Date;
}

// ── the pure decision cores ───────────────────────────────────────────────────────────────────────────────

/** Why a walked schedule did not fire this tick (a SKIP is normal control-flow, never an error). */
export type ScheduleSkipReason = "not_active" | "no_next_run" | "not_due";

/** Whether a walked schedule fires this tick, and the `scheduled_for` slot it fires for. */
export type ScheduleFireDecision =
  | { readonly kind: "fire"; readonly scheduledFor: Date }
  | { readonly kind: "skip"; readonly reason: ScheduleSkipReason };

/**
 * Decide whether one schedule fires at `now` (PURE, total). It fires only when ACTIVE, has a `next_run_at`,
 * and that `next_run_at <= now` (the due slot becomes the `scheduled_for`). A `listDue` port already filters
 * to this set; this is the belt-and-braces guard that keeps the decision unit-testable + total.
 */
export function decideScheduleFire(
  schedule: Pick<schema.ReportSchedule, "status" | "nextRunAt">,
  now: Date,
): ScheduleFireDecision {
  if (schedule.status !== "active") return { kind: "skip", reason: "not_active" };
  if (schedule.nextRunAt === null) return { kind: "skip", reason: "no_next_run" };
  if (schedule.nextRunAt > now) return { kind: "skip", reason: "not_due" };
  return { kind: "fire", scheduledFor: schedule.nextRunAt };
}

/**
 * §2.3 `CRON_TOO_FREQUENT`: the cron leaves < 5 min between the due fire and the next one (PURE). A schedule
 * this dense is rejected for the tick (no run enqueued) — it should have been blocked at the create route.
 */
export function isCadenceTooFrequent(
  scheduledFor: Date,
  nextFire: Date,
  minIntervalMs: number = MIN_SCHEDULE_INTERVAL_MS,
): boolean {
  return nextFire.getTime() - scheduledFor.getTime() < minIntervalMs;
}

// ── the orchestrator ──────────────────────────────────────────────────────────────────────────────────────

/** The per-schedule disposition the evaluator reports for one tick (telemetry; never throws on a single
 *  schedule — a bad cron is isolated to its own row). */
export interface ScheduleTickDisposition {
  readonly scheduleId: string;
  readonly outcome: "enqueued" | "collapsed" | "skipped" | "cron_too_frequent";
  readonly reason?: ScheduleSkipReason;
  /** The fired slot (ISO), when the schedule fired. */
  readonly scheduledFor?: string;
  /** The advanced `next_run_at` (ISO), when it advanced. */
  readonly nextRunAt?: string;
}

/** What one evaluator tick did across the due set. */
export interface CronEvaluatorReport {
  readonly evaluatedAt: string;
  readonly dispositions: readonly ScheduleTickDisposition[];
}

/**
 * Run one cron-evaluator tick (§2.5 / §4.8 W-R-04). Walks the due schedules; for each: decide-fire → guard
 * the §2.3 cadence → enqueue the occurrence (at-most-once) → advance `next_run_at` to the cron's next fire.
 * A `CRON_TOO_FREQUENT` schedule is audited + advanced but not enqueued. Thin — the cadence/fire logic lives
 * in the pure deciders; the cron/enqueue/advance effects are injected ports.
 */
export async function evaluateDueSchedules(
  ports: CronEvaluatorPorts,
): Promise<CronEvaluatorReport> {
  const now = ports.now();
  const due = await ports.schedules.listDue(now);
  const dispositions: ScheduleTickDisposition[] = [];

  for (const schedule of due) {
    const decision = decideScheduleFire(schedule, now);
    if (decision.kind === "skip") {
      dispositions.push({ scheduleId: schedule.id, outcome: "skipped", reason: decision.reason });
      continue;
    }

    const scheduledFor = decision.scheduledFor;
    const nextFire = ports.cron.nextRunAfter(
      schedule.cronExpression,
      schedule.tenantTimezone,
      scheduledFor,
    );

    if (isCadenceTooFrequent(scheduledFor, nextFire)) {
      const gapSeconds = Math.floor((nextFire.getTime() - scheduledFor.getTime()) / 1000);
      if (ports.audit) await ports.audit.recordCronTooFrequent(schedule.id, gapSeconds);
      // Advance anyway so the evaluator makes forward progress (does not re-fire the same dense slot).
      await ports.advance.advanceNextRun(schedule.id, nextFire);
      dispositions.push({
        scheduleId: schedule.id,
        outcome: "cron_too_frequent",
        scheduledFor: scheduledFor.toISOString(),
        nextRunAt: nextFire.toISOString(),
      });
      continue;
    }

    const { enqueued } = await ports.enqueue.enqueueRun({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      reportViewId: schedule.reportViewId,
      format: schedule.format,
      scheduledFor,
    });
    await ports.advance.advanceNextRun(schedule.id, nextFire);
    dispositions.push({
      scheduleId: schedule.id,
      outcome: enqueued ? "enqueued" : "collapsed",
      scheduledFor: scheduledFor.toISOString(),
      nextRunAt: nextFire.toISOString(),
    });
  }

  return { evaluatedAt: now.toISOString(), dispositions };
}
