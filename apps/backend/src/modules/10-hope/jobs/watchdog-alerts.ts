// apps/backend/src/modules/10-hope/jobs/watchdog-alerts.ts — the alerts the two M10 watchdogs raise: their
// deterministic plan (ids that never change, so a replay is absorbed by the emitter's dedupe) and their delivery.
// The ticks (./watchdog-ticks.ts) decide WHEN; this file decides WHAT is emitted and how failures are reported.
//
// DELIVERY — what is and is not guaranteed (see also the notes at the top of ./watchdog-ticks.ts).
//  - A THROWN (or timed-out) emit is retried: every tick re-plans its alerts from the database, and `AlertEmitter` dedupes on
//    `(organization, correlationId)`, so the next tick re-emits it until it succeeds or the replay window passes.
//  - A zero-recipient emit is NOT retried: it returns normally, the alert row is recorded once with no deliveries, and the
//    dedupe then absorbs every replay (a repeat pages nobody). M10 CANNOT DETECT "this stored alert reached nobody": `emit`
//    returns only `{ alertId, resolvedRecipientCount }`, and the count is the emitter's per-call recomputation from TODAY's
//    rules and resolvers, made before the dedupe, so it says nothing about the stored alert and a deduped replay looks like a
//    first recording. The error log on a zero count is therefore a hint about today's rules, in both directions: it can stay
//    silent after a rule was fixed while the alert recorded earlier was never delivered, and it repeats on every replay of an
//    alert that WAS delivered but whose recipients resolve to nobody today. Reporting the stored delivery count belongs to
//    M36's persist (an open decision for its owner), not to this file.
//  - Emits are bounded: one emit may take at most `M10_ALERT_EMIT_TIMEOUT_MS` (a timeout counts as a failed emit; the emit
//    itself cannot be cancelled and may still finish, which the dedupe absorbs). Every failed emit is logged and counted, and
//    a failed emit does not hide the org's later alerts.
//  - A DOWN emitter costs a few emits per org per tick, not one per alert: after `M10_ALERT_MAX_CONSECUTIVE_FAILURES`
//    failures IN A ROW, the org's LAST alert is emitted once as a probe. If it fails too, the emitter is treated as down and
//    the rest wait for the next tick. If it answers, the failures were per alert (a poisoned payload, a recipient resolver
//    that throws for one patient), so the remaining alerts are all attempted, each within the deadline and while the
//    abandoned-emit cap below allows: a few alerts that always fail at the head of the list do not starve the ones behind
//    them. A poisoned LAST alert defeats the probe, so the rest are retried only while the end of the list still answers.
//  - Abandoned emits are capped: a timed-out emit keeps running (it can hold a pooled connection and a transaction for as
//    long as it hangs), so the module counts the timed-out emits that have not settled yet. The cap is PER ORG
//    (`M10_ALERT_MAX_ABANDONED_EMITS`), so one org whose emitter hangs stops itself and not the others; a much larger
//    process-wide ceiling (`M10_ALERT_MAX_ABANDONED_EMITS_PROCESS`, the pool guard and the only cross-org limit) stops every
//    org. It is checked before EVERY emit, not only on entry: at the cap the org's remaining alerts are not emitted, the org
//    is logged, and its tick is reported as failed (so an org whose alerts hang one by one costs at most
//    `M10_ALERT_MAX_ABANDONED_EMITS` timed-out waits of `M10_ALERT_EMIT_TIMEOUT_MS` per tick, not one per alert; an emit that
//    THROWS slowly, rather than hanging, is not counted and is not capped). An
//    emit that settles frees its slot, so the next tick resumes by itself; one that never settles holds its slot until the
//    process restarts. When an abandoned emit finally settles it is logged (ids and error label only), so the root cause of
//    the hang, and whether the alert was in fact recorded, is not lost. The counts are per process (not across replicas).
import { sqlStateOf } from "../sql-state";
import { withinDeadline } from "./deadline";
import type { HopeScheduleSnapshot, PlannedHopeEvent, SfvWatchdogSnapshot } from "./index";

export interface HopeAlertEmitPort {
  emit(
    orgId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: "info" | "warn" | "critical";
      readonly correlationId: string;
    },
  ): Promise<{ alertId: string; resolvedRecipientCount: number }>;
}

export interface PlannedM10AlertEmission {
  readonly eventType: PlannedHopeEvent["eventName"];
  readonly severity: "info" | "warn" | "critical";
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

const WINDOW_EXPIRED_EVENT = "m10.hope.timepoint_expired";

/** The critical alert for a schedule the watchdog expired: the deterministic id never changes for a schedule. */
function windowExpiredAlert(
  organizationId: string,
  schedule: HopeScheduleSnapshot,
): PlannedM10AlertEmission {
  return {
    eventType: WINDOW_EXPIRED_EVENT,
    severity: "critical",
    correlationId: `${organizationId}:${WINDOW_EXPIRED_EVENT}:${schedule.scheduleId}:window_expired`,
    payload: {
      patientId: schedule.patientId,
      admissionId: schedule.admissionId,
      workflowType: schedule.rfaKind,
      workflowItemId: schedule.scheduleId,
      attentionState: "window_expired",
      deadline: schedule.lateDeadlineAt,
      deepLink: `/admissions/${schedule.admissionId}/hope`,
      message: "A HOPE assessment timepoint has expired.",
    },
  };
}

/** The critical alert for an SFV the watchdog moved to `overdue` or `missed`. */
function sfvAlert(
  organizationId: string,
  sfv: SfvWatchdogSnapshot,
  eventName: "m10.hope.sfv_overdue" | "m10.hope.sfv_missed",
): PlannedM10AlertEmission {
  const missed = eventName === "m10.hope.sfv_missed";
  return {
    eventType: eventName,
    severity: "critical",
    correlationId: `${organizationId}:${eventName}:${sfv.sfvId}:${missed ? "missed" : "overdue"}`,
    payload: {
      patientId: sfv.patientId,
      admissionId: sfv.admissionId,
      workflowType: "04_sfv",
      workflowItemId: sfv.sfvId,
      triggeringAssessmentId: sfv.triggeringAssessmentId,
      attentionState: missed ? "missed" : "overdue",
      deadline: sfv.dueAt,
      deepLink: sfv.admissionId
        ? `/admissions/${sfv.admissionId}/hope/sfv/${sfv.sfvId}`
        : "/hope/sfv",
      message: missed
        ? "A HOPE symptom follow-up visit was missed."
        : "A HOPE symptom follow-up visit is overdue.",
    },
  };
}

export function planM10AlertEmissions(input: {
  readonly organizationId: string;
  readonly schedules: readonly HopeScheduleSnapshot[];
  readonly sfvs: readonly SfvWatchdogSnapshot[];
  readonly events: readonly PlannedHopeEvent[];
}): PlannedM10AlertEmission[] {
  const bySchedule = new Map(input.schedules.map((s) => [s.scheduleId, s]));
  const bySfv = new Map(input.sfvs.map((s) => [s.sfvId, s]));
  const emissions: PlannedM10AlertEmission[] = [];
  for (const event of input.events) {
    if (event.eventName === WINDOW_EXPIRED_EVENT) {
      const schedule = bySchedule.get(String(event.payload.scheduleId));
      if (schedule) emissions.push(windowExpiredAlert(input.organizationId, schedule));
      continue;
    }
    const sfv = bySfv.get(String(event.payload.sfvId));
    if (sfv) emissions.push(sfvAlert(input.organizationId, sfv, event.eventName));
  }
  return emissions;
}

/**
 * A log label for an error: its class and, when a database error is on its cause chain, its SQLSTATE. Never the message
 * (a driver message can carry bound values, and so PHI). node-postgres errors are all named "error", so without the
 * SQLSTATE a failing tick's root cause (a deadlock 40P01, a lock timeout 55P03, a missing relation 42P01) is unreadable.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "non-error";
  const state = sqlStateOf(error);
  return state ? `${error.name} SQLSTATE ${state}` : error.name;
}

export interface AlertDeliveryResult {
  /** How many emits threw or timed out. */
  readonly failed: number;
  /** How many alerts were not attempted: the emitter looked down (see the header) or too many abandoned emits were still running. */
  readonly skipped: number;
  /** The first error an emit threw (or the reason nothing was emitted), to be attached as the cause of the tick's aggregate failure. */
  readonly firstError?: unknown;
}

/** After this many emits in a row that failed, the org's last alert is probed to tell a down emitter from a poisoned alert. */
export const M10_ALERT_MAX_CONSECUTIVE_FAILURES = 3;
/** How long one emit may take before the tick gives up on it and counts it as failed. */
export const M10_ALERT_EMIT_TIMEOUT_MS = 10_000;
/** At this many timed-out emits of ONE org still running, that org emits nothing more until some settle. */
export const M10_ALERT_MAX_ABANDONED_EMITS = 6;
/** At this many timed-out emits still running across ALL orgs (the pool guard), no org emits until some settle. */
export const M10_ALERT_MAX_ABANDONED_EMITS_PROCESS = 30;

/** An emit that did not answer within {@link M10_ALERT_EMIT_TIMEOUT_MS}. Logged by class only (see `describeError`). */
export class AlertEmitTimeoutError extends Error {
  constructor() {
    super(`the alert emit did not answer within ${M10_ALERT_EMIT_TIMEOUT_MS} ms`);
    this.name = "AlertEmitTimeoutError";
  }
}

/** Nothing (more) was emitted because `limit` timed-out emits are still running. Logged by class only. */
export class AlertEmitBackpressureError extends Error {
  constructor(limit: number = M10_ALERT_MAX_ABANDONED_EMITS) {
    super(`${limit} or more timed-out alert emits are still running`);
    this.name = "AlertEmitBackpressureError";
  }
}

/** Timed-out emits that have not settled yet, per org. A timed-out emit is abandoned, not cancelled, so it can still hold resources. */
const abandonedByOrg = new Map<string, number>();
let abandonedTotal = 0;

const adjustAbandoned = (organizationId: string, delta: 1 | -1): void => {
  abandonedTotal += delta;
  const next = (abandonedByOrg.get(organizationId) ?? 0) + delta;
  if (next <= 0) abandonedByOrg.delete(organizationId);
  else abandonedByOrg.set(organizationId, next);
};

/** The limit an org has reached (its own or the process-wide one) with the count behind it, or undefined when it may emit. */
function abandonedLimitReached(
  organizationId: string,
): { readonly running: number; readonly limit: number; readonly scope: string } | undefined {
  const own = abandonedByOrg.get(organizationId) ?? 0;
  if (own >= M10_ALERT_MAX_ABANDONED_EMITS) {
    return { running: own, limit: M10_ALERT_MAX_ABANDONED_EMITS, scope: "this org's" };
  }
  if (abandonedTotal >= M10_ALERT_MAX_ABANDONED_EMITS_PROCESS) {
    return {
      running: abandonedTotal,
      limit: M10_ALERT_MAX_ABANDONED_EMITS_PROCESS,
      scope: "the process's",
    };
  }
  return undefined;
}

/** Count a timed-out emit until it settles, and log how it ended (ids and the error label only, never a message). */
const trackAbandoned = (
  organizationId: string,
  alert: PlannedM10AlertEmission,
  late: Promise<{ alertId: string; resolvedRecipientCount: number }>,
): void => {
  adjustAbandoned(organizationId, 1);
  late.then(
    (result) => {
      adjustAbandoned(organizationId, -1);
      console.warn(
        `m10: the alert emit ${alert.eventType} (correlation ${alert.correlationId}) for org ${organizationId} answered after its ${M10_ALERT_EMIT_TIMEOUT_MS} ms deadline (alert ${result.alertId}); the emitter answered, so the alert is recorded and a replay is deduped.`,
      );
    },
    (error: unknown) => {
      adjustAbandoned(organizationId, -1);
      console.error(
        `m10: the alert emit ${alert.eventType} (correlation ${alert.correlationId}) for org ${organizationId} failed after its ${M10_ALERT_EMIT_TIMEOUT_MS} ms deadline: ${describeError(error)}.`,
      );
    },
  );
};

/** One emit raced against the deadline (see `withinDeadline`); a timed-out emit is counted until it settles. */
function emitWithinDeadline(
  emitter: HopeAlertEmitPort,
  organizationId: string,
  alert: PlannedM10AlertEmission,
): ReturnType<HopeAlertEmitPort["emit"]> {
  return withinDeadline(
    () => emitter.emit(organizationId, alert),
    M10_ALERT_EMIT_TIMEOUT_MS,
    () => new AlertEmitTimeoutError(),
    (late) => trackAbandoned(organizationId, alert, late),
  );
}

/**
 * Emit an org's planned alerts, in order, each within {@link M10_ALERT_EMIT_TIMEOUT_MS}. A failed emit is logged at error
 * level with ids and the error label only, and the NEXT alert is still emitted (one poisoned alert must not hide the rest).
 * {@link M10_ALERT_MAX_CONSECUTIVE_FAILURES} failures in a row probe the org's last alert (see the header): if that fails
 * too, the org stops for this tick and the rest are retried by the next one; if it answers, every remaining alert is
 * attempted. Before EVERY emit the abandoned-emit cap is re-checked (see the header): at the cap the rest are not emitted
 * and are counted as skipped, so the tick fails. An emit that RETURNS with a zero recipient count is logged at error level
 * too: the count is today's rules, not a record of who the stored alert reached (see the header), and a recorded alert is
 * never retried, so the log is the only signal.
 */
export async function deliverAlerts(
  emitter: HopeAlertEmitPort,
  organizationId: string,
  tick: string,
  alerts: readonly PlannedM10AlertEmission[],
): Promise<AlertDeliveryResult> {
  let failed = 0;
  let firstError: unknown;
  /** The cap check: when reached, logs and returns the result that stops this org (`notAttempted` alerts are skipped). */
  const stoppedByCap = (notAttempted: number): AlertDeliveryResult | undefined => {
    const reached = abandonedLimitReached(organizationId);
    if (!reached) return undefined;
    console.error(
      `m10: ${tick} emitted none of the remaining ${notAttempted} alert(s) for org ${organizationId}: ${reached.running} emit(s) timed out and are still running (limit ${reached.limit} for ${reached.scope} count), so the emitter or a seam behind it is hanging; ${failed} emit(s) failed earlier in this tick; the next tick retries the rest.`,
    );
    return {
      failed,
      skipped: notAttempted,
      firstError: firstError ?? new AlertEmitBackpressureError(reached.limit),
    };
  };
  /** One emit; true when it answered. A failed emit is logged and counted here. */
  const attempt = async (alert: PlannedM10AlertEmission): Promise<boolean> => {
    try {
      const result = await emitWithinDeadline(emitter, organizationId, alert);
      if (result.resolvedRecipientCount === 0) {
        console.error(
          `m10: ${tick} alert ${alert.eventType} (correlation ${alert.correlationId}, alert ${result.alertId}) for org ${organizationId} resolved 0 recipients under the organization's current alert rules. That is today's count, not a record of who the stored alert reached; a repeated emit is deduped, so fixing the rule or recipients now does not deliver an alert recorded earlier.`,
        );
      }
      return true;
    } catch (error) {
      failed += 1;
      if (failed === 1) firstError = error;
      console.error(
        `m10: ${tick} could not emit ${alert.eventType} (correlation ${alert.correlationId}) for org ${organizationId}: ${describeError(error)}.`,
      );
      return false;
    }
  };
  const lastIndex = alerts.length - 1;
  let consecutiveFailures = 0;
  let probed = false; // the last alert was emitted early, as the probe
  let emitterAnswered = false; // the probe answered: failures are per alert, so the breaker is off for this org
  for (const [index, alert] of alerts.entries()) {
    if (probed && index === lastIndex) break;
    const capped = stoppedByCap(alerts.length - index - (probed ? 1 : 0));
    if (capped) return capped;
    if (await attempt(alert)) {
      consecutiveFailures = 0;
      continue;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures < M10_ALERT_MAX_CONSECUTIVE_FAILURES || emitterAnswered) continue;
    const remaining = lastIndex - index;
    if (remaining === 0) break;
    const cappedBeforeProbe = stoppedByCap(remaining);
    if (cappedBeforeProbe) return cappedBeforeProbe;
    probed = true;
    if (await attempt(alerts[lastIndex] as PlannedM10AlertEmission)) {
      emitterAnswered = true;
      consecutiveFailures = 0;
      console.error(
        `m10: ${tick} for org ${organizationId}: ${M10_ALERT_MAX_CONSECUTIVE_FAILURES} alerts in a row failed but the last alert answered, so the failures are per alert; the ${remaining - 1} alert(s) between are still attempted.`,
      );
      continue;
    }
    const skipped = remaining - 1;
    if (skipped > 0) {
      console.error(
        `m10: ${tick} stopped emitting for org ${organizationId} after ${consecutiveFailures} consecutive failed emits and a failed probe of the last alert; ${skipped} remaining alert(s) skipped until the next tick.`,
      );
    }
    return { failed, skipped, firstError };
  }
  return { failed, skipped: 0, ...(failed > 0 ? { firstError } : {}) };
}
