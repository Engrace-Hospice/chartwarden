// apps/backend/src/modules/18-evv/jobs/queues.ts — M18 §4.8 BullMQ queue catalog for the cron-driven workers
// this module owns: the late-check sweep, the aggregator submitter drain, the aggregator response poller
// (GAP-056), and the `m18.dek-rotation` coordinate re-seal sweep (the backstop to its on-demand
// `m34.tenant.dek_rotation_completed` consumer, `./dek-rotation.ts`). The other two §4.8 workers are outbox consumers (aggregator-submission-prep on
// `m18.evv.check_out_recorded`, gps-spoof-detector on `check_in_recorded`/`check_out_recorded`) — they ride the
// outbox relay's own retry/DLQ, not a BullMQ queue. Pure data; the Worker construction is in `./cron-workers.ts`.

export const M18_CRON_QUEUES = {
  /** Every 15 minutes — open `missing_checkout` resolutions for check-ins with no check-out past grace (D6). */
  lateCheckSweep: "m18.late-check-sweep",
  /** Every minute — drain `queued` aggregator submissions through the adapter (D7/D11, outbox-only handoff). */
  aggregatorSubmitter: "m18.aggregator-submitter",
  /** Every 5 minutes — poll `submitted` rows for async vendors (§4.8). */
  aggregatorResponsePoller: "m18.aggregator-response-poller",
  /** Daily — re-seal coordinates still under a non-current M34 DEK version (§4.8 `m18.dek-rotation`). */
  dekRotation: "m18.dek-rotation",
} as const;

export type M18CronQueueName = (typeof M18_CRON_QUEUES)[keyof typeof M18_CRON_QUEUES];

export const M18_CRON_SCHEDULES = {
  lateCheckSweep: "*/15 * * * *",
  aggregatorSubmitter: "* * * * *",
  aggregatorResponsePoller: "*/5 * * * *",
  // The spec's "quarterly" is M34's rotation cadence; this sweep only re-seals what a rotation left behind, so
  // it runs daily (an empty selection is one index probe per org).
  dekRotation: "17 3 * * *",
} as const;

/** Job-level retry policy (the BullMQ tick itself). Per-row aggregator retry/backoff is below. */
export const M18_CRON_QUEUE_PARAMS = {
  lateCheckSweep: {
    attempts: 3,
    backoffType: "exponential",
    backoffMs: 30_000,
    concurrency: 1,
    priority: 5,
  },
  aggregatorSubmitter: {
    attempts: 3,
    backoffType: "exponential",
    backoffMs: 10_000,
    concurrency: 1,
    priority: 3,
  },
  aggregatorResponsePoller: {
    attempts: 3,
    backoffType: "exponential",
    backoffMs: 60_000,
    concurrency: 1,
    priority: 4,
  },
  // §4.8: 3 attempts, FIXED 300 s backoff.
  dekRotation: {
    attempts: 3,
    backoffType: "fixed",
    backoffMs: 300_000,
    concurrency: 1,
    priority: 6,
  },
} as const;

/** §4.8 / D6 — the default late-checkout grace after `scheduled_ended_at` (no tenant grace column exists yet). */
export const M18_LATE_CHECKOUT_GRACE_MS = 4 * 60 * 60 * 1000;
/** A sweep looks back this far for visits that ended without a check-out (older ones are an audit concern). */
export const M18_LATE_CHECK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows handled per org per tick — bounded so one tenant cannot starve the others. */
export const M18_TICK_BATCH_LIMIT = 100;

/** §4.8 aggregator-submitter default retry policy (an adapter without its own): 5 attempts, exponential from 60 s. */
export const M18_SUBMIT_MAX_ATTEMPTS = 5;
export const M18_SUBMIT_BACKOFF_BASE_MS = 60_000;
/** A `submitting` row older than this crashed mid-call; the next tick re-queues it (`circuit_retry`). */
export const M18_SUBMITTING_STALE_MS = 10 * 60 * 1000;
/** A `submitted` row still unanswered after this long is a timeout (the vendor SLA window). */
export const M18_POLL_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** Exponential backoff for the Nth failed attempt (1-based), capped at 1 hour. */
export function submitBackoffMs(attemptCount: number): number {
  const exp = Math.max(0, attemptCount - 1);
  return Math.min(M18_SUBMIT_BACKOFF_BASE_MS * 2 ** exp, 60 * 60 * 1000);
}
