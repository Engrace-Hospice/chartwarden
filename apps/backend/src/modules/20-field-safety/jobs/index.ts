// apps/backend/src/modules/20-field-safety/jobs — M20's §4.8 `m20.sos-sla-watchdog.cron` (D7,
// M20-F05 / S13 / INT-031, #249/F-111). Pure data — the §4.8 queue catalog — same split as M9/M33's
// `jobs/index.ts` (pure catalog) vs. `jobs/cron-workers.ts` (the live BullMQ construction), so the
// worker binds at app boot and this file stays importable with no BullMQ dependency.
//
// The decider (`../lifecycle/sos-escalator.ts`'s `decideSosWatchdog`) has been complete and unit-tested
// since M20-T03 with no production caller anywhere (F-111, #249): no file under this module matched
// `*cron*`/`*worker*`/`*job*`, and the composition root wired M20's outbox consumers but registered no
// cron worker for this module at all. An unacknowledged SOS alert sat in `acknowledging` (or any later
// tier) forever, since the 15-second scan that is supposed to notice a breached SLA never ran.
export const M20_QUEUES = {
  /** §3.4's own comment on `ssa_sla_scan_idx`: "the SLA watchdog's hot path (every 15 seconds)". One
   *  queue: the decider is per-alert and branches on lifecycle state itself (the cancel-window sweep,
   *  the tier dwell, the terminus loop), so there is one tick to schedule, not several. */
  sosSlaWatchdog: "safety.sos-sla-watchdog",
} as const;

export type M20QueueName = (typeof M20_QUEUES)[keyof typeof M20_QUEUES];

/** BullMQ moves a job here after `attempts` exhausted; ops alerts off depth (the M9/M33 convention —
 *  no separate literal `Queue` is constructed for it, `removeOnFail: false` keeps the queue's own
 *  failed-jobs set as the de facto DLQ). */
export const M20_DLQ = {
  sosSlaWatchdog: "safety.sos-sla-watchdog.dlq",
} as const;

/** The reserved cron name `sos-escalator.ts`'s own header names (`m20.sos-sla-watchdog.cron`) — used
 *  as the repeatable job's name, not the queue name, so a log line or BullMQ UI reads the same id the
 *  decider's own comments already use. */
export const M20_SOS_WATCHDOG_JOB_NAME = "m20.sos-sla-watchdog.cron";

/** Every 15 seconds, per the schema's own `ssa_sla_scan_idx` comment. Sub-minute, so `every` (ms), not
 *  a cron `pattern` — the M33 `lagProbeEveryMs` precedent (`jobs/m33-jobs.ts`'s `scheduleM33Jobs`). */
export const M20_JOB_SCHEDULES = {
  sosSlaWatchdogEveryMs: 15_000,
} as const;

/** The §4.8 BullMQ parameters (priority / attempts / backoff / concurrency) — declared as data, the
 *  M09-F12 convention ("every job declares full parameters"). Short backoff and few attempts: a failed
 *  tick is retried by the NEXT scheduled tick 15 seconds later regardless, so holding a job in retry for
 *  minutes only delays how soon a fresh scan runs. */
export const M20_QUEUE_PARAMS = {
  sosSlaWatchdog: { priority: 1, attempts: 2, backoff: "fixed 5s", concurrency: 1 },
} as const;
