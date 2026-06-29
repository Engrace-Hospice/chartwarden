// apps/backend/src/modules/24-billing-medicaid/jobs/queues.ts — the M24 §4.9 BullMQ queue + cron catalog.
// Pure constants (no bullmq import) so the catalog is importable everywhere. The event-driven queues
// (submit / submit.retry / poll / revalidate) are driven by the outbox + submission results; the four crons
// run on repeatable UTC schedules. Concurrency + retry policy per §4.9.
export const M24_QUEUES = {
  submit: "medicaid-claim.submit",
  submitRetry: "medicaid-claim.submit.retry",
  poll: "medicaid-claim.poll",
  revalidate: "medicaid-revalidate",
} as const;

export const M24_CRON_QUEUES = {
  ackPull: "medicaid-ack-pull",
  eligibilityStaleWatchdog: "medicaid-eligibility-stale-watchdog",
  rbDayDailySweep: "rb-day-daily-sweep",
  stateChannelHealth: "state-channel-health",
} as const;

/** Repeatable cron patterns (UTC). The local-time spec schedules are pinned to UTC at construction. */
export const M24_JOB_SCHEDULES = {
  ackPull: "*/15 * * * *", // every 15 min per state per channel
  eligibilityStaleWatchdog: "0 2 * * *", // daily 02:00
  rbDayDailySweep: "30 1 * * *", // daily 01:30
  stateChannelHealth: "*/15 * * * *", // every 15 min per state per channel
} as const;

export const M24_QUEUE_PARAMS = {
  submit: { concurrency: 8 },
  poll: { concurrency: 16 },
  revalidate: { concurrency: 16 },
  ackPull: { concurrency: 4 },
  eligibilityStaleWatchdog: { concurrency: 1 },
  rbDayDailySweep: { concurrency: 1 },
  stateChannelHealth: { concurrency: 4 },
} as const;
