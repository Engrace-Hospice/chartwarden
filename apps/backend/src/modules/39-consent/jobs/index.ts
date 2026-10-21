// apps/backend/src/modules/39-consent/jobs/index.ts — M39's §4.9 cron tier as DATA (F-216; the
// M14/M20 `jobs/index.ts` split: this file has no BullMQ import, `./cron-workers.ts` is the live
// construction). The two queue NAMES are the `@chartwarden/consent` `M39_QUEUES` catalog (single source);
// schedules/params/bounds live here.
//
// TIER: these are the two M39 §4.9 queues that produce outbox events —
//   • `m39.consent_expiration`   hourly — `status='active' AND expires_at <= now()` → `expired`, emits
//     `m39.consent.expired` in the SAME transaction as the flip (M5's §7.6 privacy snapshot consumes it).
//   • `m39.expiration_reminder`  hourly — the 90/30/14/7/1-day windows → one `consent_expiration_reminder`
//     row + `m39.consent.expiring_soon` per (consent, kind), idempotent on the row's key.
//   • `m39.revocation_cascade_retry` (GAP-171) — sweeps stuck revocation cascades (`./cascade-retry.ts`):
//     completes, re-fires, or declares `partial_failed` and raises the CRITICAL alert.
//   • `m39.renewal_cycle_close` (nightly 03:00) and `m39.draft_auto_expire` (daily 04:00) (GAP-171,
//     `./housekeeping.ts`): close renewal cycles whose source consent expired/was revoked/superseded, and discard
//     unsigned drafts older than 30 days.
// The two event queues are NOT built here (eval-audit-partition is redundant: the 0224 partition rotation
// already covers it).
import { M39_QUEUES } from "@chartwarden/consent";

export { M39_QUEUES };

/** §4.9: both crons are `0 * * * *` (hourly). */
export const M39_JOB_SCHEDULES = {
  consentExpiration: "0 * * * *",
  expirationReminder: "0 * * * *",
  /** §4.9 says every 30s; a 12-minute cadence spends the 5-attempt budget over ~1h (the machine's own
   *  documented budget) and keeps the sweep off the hot path. `cascade_started_at` spaces each attempt. */
  revocationCascadeRetry: "*/12 * * * *",
  /** §4.9: nightly 3 AM. */
  renewalCycleClose: "0 3 * * *",
  /** §4.9: daily 4 AM. */
  draftAutoExpire: "0 4 * * *",
} as const;

/** BullMQ parameters declared as data (the M09-F12 convention). A failed tick is retried by the next
 *  hourly tick regardless; short retries only cover a transient DB/Valkey blip. */
export const M39_QUEUE_PARAMS = {
  consentExpiration: { priority: 2, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
  expirationReminder: { priority: 3, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
  revocationCascadeRetry: { priority: 1, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
  renewalCycleClose: { priority: 4, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
  draftAutoExpire: { priority: 5, attempts: 3, backoff: "exponential 30s", concurrency: 1 },
} as const;

/** Per-transaction page size and the per-org, per-run page cap. This is what BOUNDS the first run on a
 *  deployment that already carries a backlog of lapsed-but-still-`active` consents: at most
 *  `pageSize * maxPagesPerOrg` rows are flipped (and events emitted) per org per hourly tick; the
 *  remainder drains on the following ticks. One page = one short transaction, so a large backlog never
 *  holds a long lock and never emits an unbounded event burst in a single commit. */
export const M39_CRON_BOUNDS = {
  pageSize: 100,
  maxPagesPerOrg: 10,
} as const;
