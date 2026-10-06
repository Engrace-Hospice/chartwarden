// apps/backend/src/modules/16-bereavement/jobs — M16's §4.9 BullMQ cron catalog (GAP-048). Pure data, the
// M20/M9 split: this file has no BullMQ import; `./cron-workers.ts` is the live Worker/Queue construction.
//
// Before GAP-048 `closeAt13Months` and `missDeadline` had no caller and no anniversary reminder was ever
// alerted: plans never auto-closed, no outreach was ever `missed`, and M30's missed/overdue counts were
// permanently 0. The four §4.9 queues below are the producers. `m16-unreachable-detector` is PROPOSE-only:
// `markUnreachable` stays the counselor's decision (§2.3), so the detector emits the
// `m16.bereavement.contact_unreachable_proposed` event (M36 alert) and never changes the contact's status.
export const M16_QUEUES = {
  close13Months: "m16-close-13mo",
  anniversaryLookahead: "m16-anniversary-lookahead",
  missDeadline: "m16-miss-deadline",
  unreachableDetector: "m16-unreachable-detector",
} as const;

export type M16QueueName = (typeof M16_QUEUES)[keyof typeof M16_QUEUES];

/** §4.9 DLQ names — `removeOnFail: false` keeps each queue's failed set as the de facto DLQ (M20 precedent). */
export const M16_DLQ = {
  close13Months: "m16-close-13mo-dlq",
  anniversaryLookahead: "m16-anniversary-dlq",
  missDeadline: "m16-miss-deadline-dlq",
  unreachableDetector: "m16-unreachable-dlq",
} as const;

/** Repeatable job names (what a log line / BullMQ UI shows). */
export const M16_JOB_NAMES = {
  close13Months: "m16.close-13mo.cron",
  anniversaryLookahead: "m16.anniversary-lookahead.cron",
  missDeadline: "m16.miss-deadline.cron",
  unreachableDetector: "m16.unreachable-detector.cron",
} as const;

/** §4.9 schedules (cron patterns, evaluated in UTC by BullMQ). */
export const M16_JOB_SCHEDULES = {
  close13Months: "0 2 * * *",
  anniversaryLookahead: "0 6 * * *",
  missDeadline: "0 * * * *",
  unreachableDetector: "0 3 * * *",
} as const;

/** §4.9 BullMQ parameters. Priority: BullMQ lower number = higher priority; low=10, normal=5. */
export const M16_QUEUE_PARAMS = {
  close13Months: {
    priority: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 2,
  },
  anniversaryLookahead: {
    priority: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 2,
  },
  missDeadline: {
    priority: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    concurrency: 4,
  },
  unreachableDetector: {
    priority: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 2,
  },
} as const;

/** §4.9 anniversary lookahead horizon. */
export const M16_ANNIVERSARY_LOOKAHEAD_DAYS = 14;

/** Per-org rows handled per tick (the next tick drains the rest; every pass is idempotent). */
export const M16_CRON_BATCH_LIMIT = 500;
