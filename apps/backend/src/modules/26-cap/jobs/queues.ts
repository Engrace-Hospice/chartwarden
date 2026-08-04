// apps/backend/src/modules/26-cap/jobs/queues.ts — the M26 §4.8 BullMQ cron-queue catalog (M26-F17). The six
// queues, their cron schedules (UTC — SD-018: the nightly fan-out is cross-tenant, no single tenant-local
// clock is meaningful), and the per-queue retry/backoff/concurrency + DLQ params. The constants are the
// single source of truth the worker construction (cron-workers.ts) + the schedule registration agree on.

export interface M26BackoffOptions {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

/** The six §4.8 cron/work queues (distinct wire names). */
export const M26_CRON_QUEUES = {
  nightlyProjection: "cap-nightly-projection",
  thresholdEvaluator: "cap-threshold-evaluator",
  capYearClose: "cap-cap-year-close",
  psrReconcile: "cap-psr-reconcile",
  platformConstantRefresh: "cap-platform-constant-refresh",
  psrVarianceWatchdog: "cap-psr-variance-watchdog",
} as const;

export type M26CronQueueName = (typeof M26_CRON_QUEUES)[keyof typeof M26_CRON_QUEUES];

/** The §4.8 cron schedules (UTC). 02:00 nightly projection; 03:00 Oct-1 close; staggered to avoid overlap. */
export const M26_JOB_SCHEDULES = {
  nightlyProjection: "0 2 * * *", // 02:00 UTC nightly (low-traffic US overnight; M26-F17 rationale)
  capYearClose: "0 3 1 10 *", // Oct 1, 03:00 UTC
  platformConstantRefresh: "0 4 15 8 *", // Aug 15, 04:00 UTC (next-year cap-amount publish reminder)
  psrVarianceWatchdog: "0 5 * * 1", // Mondays, 05:00 UTC
} as const;

export interface M26QueueParam {
  readonly concurrency: number;
  readonly attempts: number;
  readonly backoff: M26BackoffOptions;
  /** The dead-letter queue wire name (M26-F17: on-call alert fires when depth > 0). */
  readonly dlq: string;
}

const EXP = (delay: number): M26BackoffOptions => ({ type: "exponential", delay });
const FIXED = (delay: number): M26BackoffOptions => ({ type: "fixed", delay });

/** The §4.8 per-queue param catalog (attempts / backoff / concurrency / DLQ). */
export const M26_QUEUE_PARAMS = {
  nightlyProjection: {
    concurrency: 4,
    attempts: 3,
    backoff: EXP(300_000),
    dlq: "cap-nightly-projection.dlq",
  },
  thresholdEvaluator: {
    concurrency: 8,
    attempts: 5,
    backoff: EXP(60_000),
    dlq: "cap-threshold-evaluator.dlq",
  },
  capYearClose: {
    concurrency: 2,
    attempts: 3,
    backoff: EXP(600_000),
    dlq: "cap-cap-year-close.dlq",
  },
  psrReconcile: {
    concurrency: 1,
    attempts: 2,
    backoff: FIXED(300_000),
    dlq: "cap-psr-reconcile.dlq",
  },
  platformConstantRefresh: {
    concurrency: 1,
    attempts: 5,
    backoff: EXP(300_000),
    dlq: "cap-platform-constant-refresh.dlq",
  },
  psrVarianceWatchdog: {
    concurrency: 4,
    attempts: 3,
    backoff: EXP(300_000),
    dlq: "cap-psr-variance-watchdog.dlq",
  },
} as const satisfies Record<string, M26QueueParam>;

/** The day bucket (UTC `yyyy-mm-dd`) cron dedupe keys quantize on (one tick per day). */
function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The §4.8 idempotency-key builders (PHI-free; a date/cap-year bucket per cron tick). */
export const M26_IDEMPOTENCY_KEYS = {
  nightlyProjection: (at: Date): string => `cap-nightly:${dayBucket(at)}`,
  capYearClose: (capYear: string): string => `cap-year-close:${capYear}`,
  platformConstantRefresh: (capYear: string): string => `cap-constant-refresh:${capYear}`,
  psrVarianceWatchdog: (at: Date): string => `cap-psr-watchdog:${dayBucket(at)}`,
} as const;
