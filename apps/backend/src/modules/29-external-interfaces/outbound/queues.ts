// apps/backend/src/modules/29-external-interfaces/outbound/queues.ts — the M29-T08 outbound retry-sweep
// BullMQ queue/cron catalog (F-175/#248). Pure constants (no bullmq import).
//
// RETRY MECHANISM DECISION (the brief asks for one, deliberately, not left ambiguous): a POLL-BASED SWEEP
// over `idx_hmo_next_retry (status, nextRetryAt)`, not a per-row BullMQ delayed job. Reasons: (1) the index
// itself is the strongest signal of original intent — a `(status, nextRetryAt)` composite index is exactly
// what a periodic `WHERE status='queued' AND nextRetryAt<=now()` sweep needs and a per-row delayed-job
// scheme would never query; (2) a poll sweep survives a Redis flush / BullMQ queue loss with NO lost
// retries — the retry state lives entirely in Postgres, the durable system of record, and a crashed/rebuilt
// queue just re-discovers every due row on its next tick; (3) it mirrors this arc's own established cron
// shape (`24-billing-medicaid/jobs/state-channel-health-jobs.ts`, F-172) exactly — one repeatable BullMQ
// tick fanning out over active orgs, not N per-row jobs. The cost is up to one sweep-interval of added
// latency versus a precise per-row delayed job; acceptable against a 30s-minimum backoff (`retry-policy.ts`
// `OUTBOUND_BACKOFF_MS[0]`).
//
// F-182: the SAME tick also reclaims `in_flight` rows whose lease (`next_retry_at`, `OUTBOUND_IN_FLIGHT_LEASE_MS`)
// expired — no separate cron: a crashed attempt is recovered on the very next minute after its lease runs out.
export const M29_OUTBOUND_CRON_QUEUES = {
  retrySweep: "m29-outbound-retry-sweep",
} as const;

/** Every minute — the repo's other crons all use 5-field (minute-granularity) patterns (`M24_JOB_SCHEDULES`
 *  precedent); a 5-field pattern is the safest choice for cron-parser compatibility. Coarser than the
 *  smallest backoff step (30s, `retry-policy.ts` `OUTBOUND_BACKOFF_MS[0]`) by up to ~30s in the worst case —
 *  acceptable added latency for a retry, never a correctness issue (a row simply waits one more tick). */
export const M29_OUTBOUND_JOB_SCHEDULES = {
  retrySweep: "* * * * *",
} as const;

export const M29_OUTBOUND_QUEUE_PARAMS = {
  retrySweep: { concurrency: 1 },
} as const;

/** Rows claimed per org per sweep tick — bounds one tick's work under a burst of due retries. */
export const M29_OUTBOUND_RETRY_SWEEP_BATCH_SIZE = 25;
