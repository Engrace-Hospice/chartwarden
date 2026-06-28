// apps/backend/src/modules/25-remittance/jobs/queues.ts — the M25 §4.8 BullMQ cron-queue catalog. M25's
// nightly maintenance is cron-only (no per-org WORK queues): the denial-aging rebucket + the appeal-deadline
// watch. Defined locally (M25 ships no queue catalog in a domain package — the M27 jobs/queues.ts precedent).
// The constants are the single source of truth the worker construction (`cron-workers.ts`) + the schedule
// registration agree on.

/** The §4.8 backoff envelope (kept local so the catalog takes no specific bullmq type-export dependency). */
export interface M25BackoffOptions {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

/**
 * The two §4.8 cron queues. Distinct wire names so a cron tick is never delivered to the wrong worker.
 *   - denial-aging-scan    : nightly rebucket of every open denial + 30/90-day threshold alerts (§2.4).
 *   - appeal-deadline-scan : nightly T-30/14/7/1 appeal-deadline alerts (§2.4 / D6).
 */
export const M25_CRON_QUEUES = {
  denialAgingScan: "denial-aging-scan",
  appealDeadlineScan: "appeal-deadline-scan",
} as const;

export type M25CronQueueName = (typeof M25_CRON_QUEUES)[keyof typeof M25_CRON_QUEUES];

/** The §4.8 cron schedules (UTC). Both run nightly at 02:00 / 02:30 (staggered to spread DB load). */
export const M25_JOB_SCHEDULES = {
  denialAgingScan: "0 2 * * *",
  appealDeadlineScan: "30 2 * * *",
} as const;

/** One cron's §4.8 runtime params: worker concurrency + the bounded retry/backoff envelope. */
export interface M25QueueParam {
  readonly concurrency: number;
  readonly attempts: number;
  readonly backoff: M25BackoffOptions;
}

const EXPONENTIAL = (delay = 5000): M25BackoffOptions => ({ type: "exponential", delay });

/** The §4.8 cron param catalog — both crons are single-concurrency (one tick at a time), 2 retries. */
export const M25_QUEUE_PARAMS = {
  denialAgingScan: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
  appealDeadlineScan: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
} as const satisfies Record<string, M25QueueParam>;

/** The day bucket (UTC `yyyy-mm-dd`) the cron dedupe keys quantize on (one tick per day). */
function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The §4.8 idempotency-key builders (PHI-free; a date bucket per cron tick). */
export const M25_IDEMPOTENCY_KEYS = {
  denialAgingScan: (at: Date): string => `denial-aging:${dayBucket(at)}`,
  appealDeadlineScan: (at: Date): string => `appeal-deadline:${dayBucket(at)}`,
} as const;
