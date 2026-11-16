// apps/backend/src/modules/10-hope/jobs/watchdog-ticks.ts — the two M10 watchdog ticks (`hope-window-watchdog`,
// `sfv-watchdog`), split out of `cron-workers.ts`; the alert planning and delivery they share live in ./watchdog-alerts.ts.
//
// A tick, per org: read an UNLOCKED snapshot, plan the transitions, write each one keyed on the status (and, for an SFV,
// the due date) the plan was based on, publish the surviving events to the transactional outbox, and re-plan the org's
// alerts from the committed state. The tick's transaction commits first; the alerts are emitted AFTER it.
//
// ALERT DELIVERY — what is and is not guaranteed.
//  - `AlertEmitter` is not an in-tx outbox insert: it opens its own org-scoped transactions on other pooled connections
//    and resolves recipients through other modules' seams. Emitting inside the tick's transaction would hold the
//    transitioned rows' locks and a pooled connection across all of that (and a slow seam could starve the pool the
//    emitter itself needs), so the alerts are emitted after commit.
//  - A transition's alert must not depend on the ONE tick that saw it, or a failed emit would be lost (a transition is
//    planned only on its status edge, and the next tick finds the row already flipped). So every tick re-plans alerts
//    from the DATABASE state after its own writes: every SFV currently `overdue`, every SFV `missed` and every schedule
//    `expired` within the replay window (`M10_ALERT_REPLAY_LOOKBACK_DAYS`; overdue SFVs have no lookback, they are bounded
//    by the 7-day `overdue -> missed` decay). The correlation ids are deterministic and `AlertEmitter` dedupes on
//    `(organization, correlationId)` (a repeat of a delivered alert is absorbed and pages nobody), so re-emitting is
//    harmless and an emit that THREW is retried by every following tick (15 minutes) until it succeeds.
//  - NOT guaranteed: an alert whose emit keeps throwing for longer than the replay window is dropped (its outbox event
//    still exists, but no module consumes it); an emit that RETURNS with zero recipients is recorded once and never
//    retried, and M10 cannot tell from the emit's answer whether the STORED alert reached anyone (see ./watchdog-alerts.ts: the
//    count is today's rules, and a zero count is only logged at error level); an `AlertEmitter` that does not dedupe would
//    re-notify on every tick; and the replay costs, per org per tick, one emit (rule + recipient resolution, then the dedupe)
//    per overdue SFV, per SFV missed in the window and per schedule expired in the window, which is the ceiling to revisit (a
//    delivered-marker column) if those backlogs grow large. The first tick after the replay shipped also pages once for
//    every such item whose alert was never persisted before (the old emit was edge-only): an expected one-time burst.
//  - Lock waits and alert emits are bounded, so a stuck lock or a hung emit fails ITS org instead of stalling the orgs after
//    it: a tick's transaction waits at most `M10_LOCK_TIMEOUT_MS` for a row lock (a blocked write fails that org with SQLSTATE
//    55P03) and an emit gets at most `M10_ALERT_EMIT_TIMEOUT_MS` (./watchdog-alerts.ts). NOT bounded: the duration of a
//    statement that is running rather than waiting (no `statement_timeout` is set here), the pooled-connection checkout inside
//    `withOrgContext` (a saturated pool stalls the tick), and the active-org list read (`listActiveOrgs` in ./cron-workers.ts,
//    which runs once before the first org). The orgs are still ticked one after another, so an emitter that hangs for EVERY
//    emit of an org costs up to (`M10_ALERT_MAX_CONSECUTIVE_FAILURES` + 1, the probe) x `M10_ALERT_EMIT_TIMEOUT_MS` for that
//    org; one whose alerts hang one by one while the end of the list answers (the probe passes, so the rest are all attempted)
//    costs at most `M10_ALERT_MAX_ABANDONED_EMITS` x `M10_ALERT_EMIT_TIMEOUT_MS`, because the per-org cap on timed-out emits that
//    are still running (./watchdog-alerts.ts) is checked before every emit and stops that org until some settle. Another org is
//    not stopped by it; only the much larger process-wide ceiling (`M10_ALERT_MAX_ABANDONED_EMITS_PROCESS`) stops them all.
//    There is no other cross-org breaker.
//  - Every failure is logged at error level (ids and the error class plus SQLSTATE, never a message), every org is still
//    processed after one fails, a failed emit does not hide the org's later alerts, and the run throws ONCE at the end with
//    the first error as its `cause`, so the job-failure (DLQ) alert fires. What an org's tick leaves for the next one, and
//    when, is stated in ./watchdog-alerts.ts: an emitter that looks down leaves the org's remaining alerts for the next tick;
//    a few alerts that always fail do not (the org's last alert is probed first). An alert that keeps failing is retried
//    every tick only until it leaves the replay window. The two watchdog jobs run with `attempts: 1`: the next firing is the retry, and
//    BullMQ re-running the whole all-org tick would only multiply work for a poisoned org.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { M10_LOCK_TIMEOUT_MS } from "../hope-assessment-lock";
import {
  openHopeSchedulesForOrg,
  openOrOverdueSfvsForOrg,
  recentlyExpiredSchedulesForOrg,
  sfvsToReplayAlertsForOrg,
  updateHopeScheduleStatus,
  updateSfvStatus,
} from "./cron-store";
import {
  type PlannedHopeEvent,
  type SfvWatchdogSnapshot,
  planHopeWindowWatchdog,
  planSfvWatchdog,
} from "./index";
import {
  type HopeAlertEmitPort,
  type PlannedM10AlertEmission,
  deliverAlerts,
  describeError,
  planM10AlertEmissions,
} from "./watchdog-alerts";

/** The transactional-outbox port (§2.4) M10's watchdogs publish `m10.hope.*` events through, on the
 * caller's tx — the bound publisher validates every emit against the boot catalog and writes the
 * `outbox_event` row. Mirrors `HopeWriteOutboxPort` in ../hope-route-service-db.ts (kept local here so this
 * file takes no dependency on the route-service module). Defined HERE, in the leaf both the ticks and `cron-workers.ts`
 * import, so the two files do not import each other. */
export interface HopeOutboxPublishPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** How far back the tick re-plans the alerts of a TERMINAL transition (`missed` SFVs, `expired` schedules). */
const M10_ALERT_REPLAY_LOOKBACK_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** The confirmed §2.4 outbox-catalog aggregate routing for each `PlannedHopeEvent` (events-by-m10.ts):
 * `timepoint_expired` targets the schedule; `sfv_overdue`/`sfv_missed` target the SFV. */
function outboxTargetFor(event: PlannedHopeEvent): { aggregateKind: string; aggregateId: string } {
  switch (event.eventName) {
    case "m10.hope.timepoint_expired":
      return {
        aggregateKind: "hope_timepoint_schedule",
        aggregateId: String(event.payload.scheduleId),
      };
    case "m10.hope.sfv_overdue":
    case "m10.hope.sfv_missed":
      return { aggregateKind: "symptom_follow_up_visit", aggregateId: String(event.payload.sfvId) };
  }
}

/** What a watchdog tick needs: the org list, the clock, the database, the outbox and (optionally) the alert emitter. */
export interface WatchdogTickDeps {
  readonly db: DbClient;
  readonly outbox: HopeOutboxPublishPort;
  readonly alerts?: HopeAlertEmitPort;
  readonly now: Date;
  readonly organizationIds: readonly string[];
  /** The `app.user_id` the tick's tenant context carries (the empty-string system sentinel). */
  readonly systemUserId: string;
}

/**
 * Bound this transaction's lock waits to `M10_LOCK_TIMEOUT_MS` (transaction-local, like `SET LOCAL`), so a write queued behind
 * a lock a stuck transaction holds fails its org (SQLSTATE 55P03, logged and counted) instead of hanging the whole job. Call
 * it first in every cron transaction; the cron runners in ./cron-workers.ts use it too.
 */
export async function boundCronLockWait(tx: DbClient): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${M10_LOCK_TIMEOUT_MS}ms`}, true)`);
}

/** Log the transitions this tick planned but did not write (ids only), so a recurring race is visible. */
function logLostRaces(tick: string, organizationId: string, lost: ReadonlySet<string>): void {
  if (lost.size === 0) return;
  console.warn(
    `m10: ${tick} lost ${lost.size} race(s) in org ${organizationId} (ids: ${[...lost].join(", ")}); their transition events were not published.`,
  );
}

/**
 * Run `tick` for every org and deliver the alerts it plans AFTER its transaction committed. One org failing (its
 * transaction or its emits) does not stop the others; the failures are counted and the run throws once at the end, with
 * the FIRST error as its `cause` (its message is not logged: it can carry values).
 */
async function runForEachOrg(
  tickName: string,
  deps: WatchdogTickDeps,
  tick: (organizationId: string) => Promise<readonly PlannedM10AlertEmission[]>,
): Promise<void> {
  let failedOrgs = 0;
  let firstError: unknown;
  for (const organizationId of deps.organizationIds) {
    let alerts: readonly PlannedM10AlertEmission[];
    try {
      alerts = await tick(organizationId);
    } catch (error) {
      failedOrgs += 1;
      firstError ??= error;
      console.error(`m10: ${tickName} failed for org ${organizationId}: ${describeError(error)}.`);
      continue;
    }
    if (!deps.alerts || alerts.length === 0) continue;
    const delivery = await deliverAlerts(deps.alerts, organizationId, tickName, alerts);
    // An org whose alerts were not emitted (emitter looks down, or too many emits still running) is a failed org too.
    if (delivery.failed > 0 || delivery.skipped > 0) {
      failedOrgs += 1;
      firstError ??= delivery.firstError;
    }
  }
  if (failedOrgs > 0) {
    throw new Error(
      `m10: ${tickName} failed for ${failedOrgs} of ${deps.organizationIds.length} org(s); every org was still attempted`,
      { cause: firstError },
    );
  }
}

const replaySince = (now: Date): Date =>
  new Date(now.getTime() - M10_ALERT_REPLAY_LOOKBACK_DAYS * MS_PER_DAY);

/** `hope-window-watchdog` (§4.8, every 15 min) — per org, flip every `open` schedule past its late deadline to
 * `expired`, publish `m10.hope.timepoint_expired` for each transition that was written, and alert on the schedules that
 * expired within the replay window (see the delivery notes above). */
export async function runWindowWatchdogTick(deps: WatchdogTickDeps): Promise<void> {
  await runForEachOrg("hope-window-watchdog", deps, (organizationId) =>
    withOrgContext(deps.db, { organizationId, userId: deps.systemUserId }, async (tx) => {
      const t = tx as unknown as DbClient;
      await boundCronLockWait(t);
      const schedules = await openHopeSchedulesForOrg(t, organizationId);
      const plan = planHopeWindowWatchdog(schedules, deps.now.toISOString());
      // A schedule a sign completed (or another tick expired) since the snapshot is not written, so its event is not
      // published either: a completed timepoint must never announce itself expired.
      const lostRace = new Set<string>();
      for (const transition of plan.transitions) {
        if (!transition.changed) continue;
        if (
          !(await updateHopeScheduleStatus(
            t,
            organizationId,
            transition.scheduleId,
            transition.toStatus,
          ))
        ) {
          lostRace.add(transition.scheduleId);
        }
      }
      logLostRaces("hope-window-watchdog", organizationId, lostRace);
      for (const event of plan.events) {
        if (lostRace.has(String(event.payload.scheduleId))) continue;
        await deps.outbox.publish(t, {
          eventName: event.eventName,
          payload: event.payload,
          organizationId,
          ...outboxTargetFor(event),
        });
      }
      if (!deps.alerts) return [];
      const expired = await recentlyExpiredSchedulesForOrg(
        t,
        organizationId,
        replaySince(deps.now),
      );
      return planM10AlertEmissions({
        organizationId,
        schedules: expired,
        sfvs: [],
        events: expired.map((schedule) => ({
          eventName: "m10.hope.timepoint_expired" as const,
          payload: {
            scheduleId: schedule.scheduleId,
            rfaKind: schedule.rfaKind,
            expiredAt: schedule.lateDeadlineAt,
          },
        })),
      });
    }),
  );
}

/** The alert event an SFV's CURRENT status calls for (the status the replay re-plans from). */
const sfvAlertEvent = (sfv: SfvWatchdogSnapshot, now: Date): PlannedHopeEvent =>
  sfv.status === "missed"
    ? { eventName: "m10.hope.sfv_missed", payload: { sfvId: sfv.sfvId } }
    : {
        eventName: "m10.hope.sfv_overdue",
        payload: {
          sfvId: sfv.sfvId,
          hoursPastDue: Math.max(
            0,
            Math.floor((now.getTime() - Date.parse(sfv.dueAt)) / 3_600_000),
          ),
        },
      };

/** `sfv-watchdog` (§4.8, every 15 min) — per org, decay every `open`/`overdue` SFV (→ `overdue`/`missed`) and
 * publish `m10.hope.sfv_overdue` / `m10.hope.sfv_missed` only on the transition edge, for transitions that were written.
 * Alerts are re-planned from the SFVs currently overdue or recently missed (see the delivery notes above). */
export async function runSfvWatchdogTick(deps: WatchdogTickDeps): Promise<void> {
  await runForEachOrg("sfv-watchdog", deps, (organizationId) =>
    withOrgContext(deps.db, { organizationId, userId: deps.systemUserId }, async (tx) => {
      const t = tx as unknown as DbClient;
      await boundCronLockWait(t);
      const sfvs = await openOrOverdueSfvsForOrg(t, organizationId);
      const plan = planSfvWatchdog(sfvs, deps.now.toISOString());
      // A transition `updateSfvStatus` does not write is a lost race: the SFV was completed or withdrawn since the
      // snapshot, a reconcile moved its due date, or an overlapping tick already flipped it (the flip is keyed on the
      // snapshot's exact status and due date). Its event must not fire, or a completed SFV would announce itself
      // overdue/missed and an overlapping tick would announce the same flip twice.
      const snapshotOf = new Map(sfvs.map((sfv) => [sfv.sfvId, sfv]));
      const lostRace = new Set<string>();
      for (const transition of plan.transitions) {
        if (!transition.changed) continue;
        const snapshot = snapshotOf.get(transition.sfvId);
        const from = transition.fromStatus;
        const flipped =
          snapshot !== undefined &&
          (from === "open" || from === "overdue") &&
          (await updateSfvStatus(t, {
            organizationId,
            sfvId: transition.sfvId,
            from,
            to: transition.toStatus,
            snapshotDueAt: snapshot.dueAt,
          }));
        if (!flipped) lostRace.add(transition.sfvId);
      }
      logLostRaces("sfv-watchdog", organizationId, lostRace);
      for (const event of plan.events) {
        if (lostRace.has(String(event.payload.sfvId))) continue;
        await deps.outbox.publish(t, {
          eventName: event.eventName,
          payload: event.payload,
          organizationId,
          ...outboxTargetFor(event),
        });
      }
      if (!deps.alerts) return [];
      const replay = await sfvsToReplayAlertsForOrg(t, organizationId, replaySince(deps.now));
      return planM10AlertEmissions({
        organizationId,
        schedules: [],
        sfvs: replay,
        events: replay.map((sfv) => sfvAlertEvent(sfv, deps.now)),
      });
    }),
  );
}
