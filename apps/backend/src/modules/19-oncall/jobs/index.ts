// apps/backend/src/modules/19-oncall/jobs — M19's §4.8 `m19.shift-sync.debounced` queue catalog (the m19
// `handlers-unbound` group, #248; F-155's own finding, now built). Same split as M9/M20/M33's
// `jobs/index.ts` (pure catalog) vs. `jobs/cron-workers.ts`/`worker.ts` (the live BullMQ construction), so
// the worker binds at app boot and this file stays importable with no BullMQ dependency.
//
// `reconcileOnCallRoster`/`decideRosterSyncTrigger` (`../roster/shift-sync.ts`) have been complete, pure,
// well-documented since M19-T04 with no production caller anywhere: no file under `19-oncall/` matched
// `*jobs*`/`*cron*`/`*worker*`, and the composition root wired M19's D10 inbound triggers (F-043/#103) but
// registered no cron/queue infrastructure for this module at all. §4.5's Direct-model roster sync — the
// mechanism that turns M17's on-call roster into `on_call_shift` rows in the first place — had never run.
//
// TWO QUEUES, ONE SHARED TABLE. `rosterSyncDrain` is the spec's own `m19.shift-sync.debounced` — it claims
// due rows off `on_call_roster_sync_queue` and reconciles. `rosterSyncCatchup` is the spec's OTHER named
// trigger ("at every shift cron tick") for the SAME reconciliation — it does not reconcile directly; its
// only action is to SEED a `cron_catchup` row (via `OnCallRosterSyncQueueRepository.ensureCatchUpPending`)
// for an org that has no debounce currently in flight, so the drain queue is the single place any
// reconciliation actually executes (see `../../../../packages/db/src/schema/oncall/
// on-call-roster-sync-queue.ts`'s header for why this avoids two competing writers to `on_call_shift`).
export const M19_QUEUES = {
  rosterSyncDrain: "oncall.shift-sync.debounced",
  rosterSyncCatchup: "oncall.shift-sync.catchup-seed",
  // GAP-057 — the three §4.8 Tier-1 queues (`m19.shift-open.cron`, `m19.shift-close.cron`,
  // `m19.coverage-gap-watchdog.cron`), named in this file's `oncall.` dotted-segment convention.
  shiftOpen: "oncall.shift-open.cron",
  shiftClose: "oncall.shift-close.cron",
  coverageGapWatchdog: "oncall.coverage-gap-watchdog.cron",
  // GAP-057 follow-up (b11) — the four remaining §4.8 crons (`m19.callback-sla.cron`,
  // `m19.awaiting-callback-timeout.cron`, `m19.close-documented.cron`, `m19.escalation-sla`).
  callbackSla: "oncall.callback-sla.cron",
  awaitingCallbackTimeout: "oncall.awaiting-callback-timeout.cron",
  closeDocumented: "oncall.close-documented.cron",
  escalationSla: "oncall.escalation-sla.cron",
} as const;

export type M19QueueName = (typeof M19_QUEUES)[keyof typeof M19_QUEUES];

/** BullMQ moves a job here after `attempts` exhausted; ops alerts off depth (the M9/M20/M33 convention —
 *  no separate literal `Queue` is constructed for it, `removeOnFail: false` keeps the queue's own
 *  failed-jobs set as the de facto DLQ). Only the drain queue carries real per-tick work that can fail;
 *  the catch-up seeder's own INSERT is a single idempotent statement with nothing to retry meaningfully. */
export const M19_DLQ = {
  rosterSyncDrain: "oncall.shift-sync.debounced.dlq",
  shiftOpen: "oncall.shift-open.dlq",
  shiftClose: "oncall.shift-close.dlq",
  coverageGapWatchdog: "oncall.coverage-gap.dlq",
  callbackSla: "oncall.callback-sla.dlq",
  awaitingCallbackTimeout: "oncall.callback-timeout.dlq",
  closeDocumented: "oncall.close-documented.dlq",
  escalationSla: "oncall.escalation-sla.dlq",
} as const;

/** The reserved job names — used as the repeatable job's `name`, not the queue name, so a log line or
 *  BullMQ UI reads the same id the spec's own §4.8 table and this directory's comments already use. */
export const M19_ROSTER_SYNC_DRAIN_JOB_NAME = "m19.shift-sync.debounced";
export const M19_ROSTER_SYNC_CATCHUP_JOB_NAME = "m19.shift-sync.catchup-seed";
export const M19_SHIFT_OPEN_JOB_NAME = "m19.shift-open.cron";
export const M19_SHIFT_CLOSE_JOB_NAME = "m19.shift-close.cron";
export const M19_COVERAGE_GAP_WATCHDOG_JOB_NAME = "m19.coverage-gap-watchdog.cron";
export const M19_CALLBACK_SLA_JOB_NAME = "m19.callback-sla.cron";
export const M19_AWAITING_CALLBACK_TIMEOUT_JOB_NAME = "m19.awaiting-callback-timeout.cron";
export const M19_CLOSE_DOCUMENTED_JOB_NAME = "m19.close-documented.cron";
export const M19_ESCALATION_SLA_JOB_NAME = "m19.escalation-sla";

/**
 * §4.8: "debounced 30 s on `m17.visit.assigned`" — the window `OnCallRosterSyncQueueRepository
 * .triggerDebounce` bumps `run_after` forward by on every trigger.
 */
export const M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS = 30_000;

/**
 * The drain tick runs more often than the debounce window so a resolved debounce (30 s of quiet) is
 * picked up promptly rather than waiting out a coarser tick; the catch-up seeder runs on the spec's own
 * "shift cron tick" cadence — the SAME 5-minute cadence §4.8's `shift-open.cron`/`shift-close.cron` rows
 * use, since the spec names no cadence of its own for this second trigger and that is the one other cron
 * cadence its text ties to "shift" scheduling. Stated as the assumption it is, not invented silently.
 */
export const M19_JOB_SCHEDULES = {
  rosterSyncDrainEveryMs: 10_000,
  rosterSyncCatchupEveryMs: 5 * 60_000,
  /** §4.8 — `shift-open.cron` / `shift-close.cron` every 5 min; the watchdog every 30 min (canonical). */
  shiftOpenEveryMs: 5 * 60_000,
  shiftCloseEveryMs: 5 * 60_000,
  coverageGapWatchdogEveryMs: 30 * 60_000,
  /** §4.8 — `callback-sla` every minute, `awaiting-callback-timeout` every 10 min, `close-documented` every
   *  15 min, `escalation-sla` every 5 min. */
  callbackSlaEveryMs: 60_000,
  awaitingCallbackTimeoutEveryMs: 10 * 60_000,
  closeDocumentedEveryMs: 15 * 60_000,
  escalationSlaEveryMs: 5 * 60_000,
} as const;

/**
 * The §4.8 BullMQ parameters for the drain queue (priority / attempts / backoff / concurrency), declared
 * as data (the M09-F12 "every job declares full parameters" convention) and transcribed from the spec's
 * own table row verbatim: "2 | 2 per org | 3 | exponential 15 s, 30 s, 60 s". BullMQ's built-in
 * exponential backoff is `delay * 2^(attempt-1)`, so a base delay of 15 s reproduces the spec's exact
 * 15 s / 30 s / 60 s sequence across 3 attempts (the M20 `parseBackoff` convention — a backoff STRING
 * carries only the base delay + type; a coarser tick 15 s later would re-scan regardless). The catch-up
 * seeder gets its own, deliberately looser parameters: a missed seed is caught by the NEXT 5-minute tick,
 * so there is nothing worth retrying within the same pass.
 */
export const M19_QUEUE_PARAMS = {
  rosterSyncDrain: { priority: 2, attempts: 3, backoff: "exponential 15s", concurrency: 2 },
  rosterSyncCatchup: { priority: 3, attempts: 1, backoff: "fixed 5s", concurrency: 1 },
  // §4.8 Tier-1 rows, verbatim: priority 1, 1 per org (the tick is a sequential per-org fan-out, so one
  // worker slot), attempts 3 and the spec's exponential schedules (base delay x 2^(attempt-1)).
  shiftOpen: { priority: 1, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
  shiftClose: { priority: 1, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
  coverageGapWatchdog: { priority: 1, attempts: 3, backoff: "exponential 60s", concurrency: 1 },
  // §4.8 rows, verbatim except `escalationSla`'s concurrency: the spec says "2 per org", but the tick is a
  // sequential per-org fan-out, so one worker slot (two would only let ticks overlap on the same rows).
  callbackSla: { priority: 2, attempts: 2, backoff: "fixed 15s", concurrency: 1 },
  awaitingCallbackTimeout: { priority: 3, attempts: 2, backoff: "fixed 30s", concurrency: 1 },
  closeDocumented: { priority: 3, attempts: 2, backoff: "fixed 30s", concurrency: 1 },
  escalationSla: { priority: 2, attempts: 2, backoff: "fixed 30s", concurrency: 1 },
} as const;

// NOTE: this file stays PURE DATA with no BullMQ import (the M20 `jobs/index.ts` precedent) — `./worker.ts`
// imports the constants above FROM here, so re-exporting `./worker.ts`'s own symbols back through this
// barrel would be circular. The composition root imports `./repository`, `./reconcile`, `./worker` and
// `./wiring` directly.
