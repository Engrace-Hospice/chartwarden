// apps/backend/src/modules/23-billing-medicare/jobs/queues.ts — the M23 §4.8 BullMQ queue catalog.
//
// @wardenx/billing ships the PURE domain (the claim/noe/notr lifecycle reducers, the HIPPS/SIA/sequestration/
// TOB calculators, the validation rule registry, the control-number deriver) but — like @wardenx/cost-report
// (M27) and unlike @wardenx/quality (M30) — it does NOT ship a BullMQ queue/param catalog. So the §4.8
// catalog is defined LOCALLY here, the single source of truth the worker construction (`m23-jobs.ts`) and the
// composition-root producer (`routes/write-service-drizzle.ts`'s `JobEnqueuePort`) agree on.
//
// WIRE-NAME PARITY (the M27 lesson): the §4.8 spec table prefixes each queue with `m23.`; the ALREADY-BUILT
// write-service producer enqueues onto BARE names (`"claim.submit"`, `"noe.submit"`, `"notr.submit"`,
// `"eligibility.refresh"`, `"validation-run"`). The producer is a shared file that must not be edited, so the
// WORK-queue constants below are the BARE names the producer actually uses — that is what keeps the
// producer↔consumer wire names 1:1. The cron + retry + consumer queues have no producer yet, so they take
// the bare names consistent with the work queues.

/** The §4.8 backoff envelope (kept local so the catalog takes no specific bullmq type-export dependency). */
export interface M23BackoffOptions {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

/**
 * The §4.8 WORK queues — the producer fans org-scoped jobs onto these (via the outbox-drained
 * `JobEnqueuePort`); the workers consume them under a per-job `withOrgContext` RLS envelope.
 */
export const M23_QUEUES = {
  /** Drain `m23.claim.submit_requested`: generate 837I, upload to MAC, write submission row, READY→SUBMITTED. */
  claimSubmit: "claim.submit",
  /** Retry MAC portal upload with exponential backoff; max 5 attempts; on exhaustion emit submission_stalled. */
  claimSubmitRetry: "claim.submit.retry",
  /** Drain `m23.noe.submit_requested`: generate NOE, upload, write submission row, NOE READY→SUBMITTED. */
  noeSubmit: "noe.submit",
  /** Drain `m23.notr.submit_requested`: parallel to NOE. */
  notrSubmit: "notr.submit",
  /** Drain `m23.transfer_notice.submit_requested`: generate the 8xC / 8xD, upload, READY→SUBMITTED. */
  transferNoticeSubmit: "transfer_notice.submit",
  /** Drain `m23.eligibility.refresh_requested`: unlock MBI, run HETS 270/271, append eligibility_check row. */
  eligibilityRefresh: "eligibility.refresh",
  /** Drain a validation-run job (validateClaim route + revalidate consumer enqueue this): run rules, transition. */
  validationRun: "validation-run",
  /** Consume the §4.8 revalidation events: find affected VALIDATING/READY claims, enqueue a re-validation run. */
  revalidateConsumer: "revalidate.consumer",
} as const;

export type M23QueueName = (typeof M23_QUEUES)[keyof typeof M23_QUEUES];

/**
 * The §4.8 CRON queues — distinct wire names from the WORK queues so a cron tick is never delivered to a
 * per-org worker. The ack-pull + mac-portal-health crons are per-MAC-jurisdiction; the window/stale watchdogs
 * are per-org (fanned inside the processor).
 */
export const M23_CRON_QUEUES = {
  /** Pull pending 999 files from each MAC portal, parse, write ack rows, drive claim state (every 15 min). */
  ackPull999: "ack.pull-999",
  /** Pull pending 277CA files from each MAC portal; drives ACK_PENDING → ACK_ACCEPTED/REJECTED/PARTIAL. */
  ackPull277ca: "ack.pull-277ca",
  /** Walk NOE rows approaching the 5-day window; warn at day 3, breach at day 5+1 (every 30 min). */
  noeWindowWatch: "noe.window-watch",
  /** Walk NOTR rows approaching the window; parallel to NOE (every 30 min). */
  notrWindowWatch: "notr.window-watch",
  /** Mark eligibility_check rows past staleAt; emit m23.eligibility.expired per patient (daily 06:00). */
  eligibilityStaleWatch: "eligibility.stale-watch",
  /** Probe MAC portal availability; emit unavailable on down-transition, recovered on up (every 5 min). */
  macPortalHealth: "mac-portal.health",
} as const;

export type M23CronQueueName = (typeof M23_CRON_QUEUES)[keyof typeof M23_CRON_QUEUES];

/** The §4.8 cron schedules (UTC cron patterns; org-TZ semantics resolved inside the processor). */
export const M23_JOB_SCHEDULES = {
  ackPull999: "*/15 * * * *", // every 15 minutes
  ackPull277ca: "*/15 * * * *", // every 15 minutes
  noeWindowWatch: "*/30 * * * *", // every 30 minutes
  notrWindowWatch: "*/30 * * * *", // every 30 minutes
  eligibilityStaleWatch: "0 6 * * *", // daily 06:00 (org-TZ resolved in the processor)
  macPortalHealth: "*/5 * * * *", // every 5 minutes
} as const;

/** One queue's §4.8 runtime parameters: worker concurrency + the producer-side retry/backoff envelope. */
export interface M23QueueParam {
  /** BullMQ `Worker` concurrency (the only param the worker constructor consumes). */
  readonly concurrency: number;
  /** Bounded retries (the producer applies this on `Queue.add`; surfaced here as the §4.8 catalog). */
  readonly attempts: number;
  /** Exponential backoff (the producer applies this on `Queue.add`). */
  readonly backoff: M23BackoffOptions;
}

/** Exponential backoff with the standard 5s base (the M23 retry envelope). */
const EXPONENTIAL = (delay = 5000): M23BackoffOptions => ({ type: "exponential", delay });

/**
 * The §4.8 queue param catalog — concurrency + bounded-retry/backoff per queue, transcribed from the spec
 * §4.8 table. The worker construction reads `.concurrency`; the producer's `JobEnqueuePort` adapter reads
 * `.attempts`/`.backoff` when it calls `Queue.add`. `claim.submit.retry` carries the §4.8 max-5 retry budget.
 */
export const M23_QUEUE_PARAMS = {
  // 2 per org | outbox-drained; the SUBMITTED upload retries on the dedicated retry queue
  claimSubmit: { concurrency: 2, attempts: 1, backoff: EXPONENTIAL() },
  // 2 per org | exponential, MAX 5 attempts (§4.8); on exhaustion → submission_stalled alert
  claimSubmitRetry: { concurrency: 2, attempts: 5, backoff: EXPONENTIAL() },
  // 2 per org
  noeSubmit: { concurrency: 2, attempts: 3, backoff: EXPONENTIAL() },
  // 2 per org
  notrSubmit: { concurrency: 2, attempts: 3, backoff: EXPONENTIAL() },
  // 2 per org | a failed generate/upload is recorded on the attempt row (no BullMQ retry; staff resubmit)
  transferNoticeSubmit: { concurrency: 2, attempts: 1, backoff: EXPONENTIAL() },
  // 4 per org
  eligibilityRefresh: { concurrency: 4, attempts: 4, backoff: EXPONENTIAL() },
  // 4 per org | the validation rule library run
  validationRun: { concurrency: 4, attempts: 4, backoff: EXPONENTIAL() },
  // 4 per org | idempotent on (event_id, target_claim_id)
  revalidateConsumer: { concurrency: 4, attempts: 4, backoff: EXPONENTIAL() },
  // 1 per MAC jurisdiction (cron) | every 15 min
  ackPull999: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
  // 1 per MAC jurisdiction (cron) | every 15 min
  ackPull277ca: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
  // 1 per org (cron) | every 30 min
  noeWindowWatch: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
  // 1 per org (cron) | every 30 min
  notrWindowWatch: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
  // 1 per org (cron) | daily 06:00
  eligibilityStaleWatch: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
  // 1 per MAC jurisdiction (cron) | every 5 min
  macPortalHealth: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
} as const satisfies Record<string, M23QueueParam>;

// ── §4.8 idempotency keys (the consumer dedupe-key shapes — all consumer queues idempotent per the spec) ──

/** The UTC day bucket (`yyyy-mm-dd`) the eligibility-refresh dedupe key quantizes on (one per service day). */
function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The §4.8 idempotency-key builders. Each yields the canonical dedupe key for its queue so the producer
 * and any worker-side replay guard agree on identity. PHI-free / MBI-free (D13); ids + buckets only. The
 * revalidate consumer is idempotent on `(event_id, target_claim_id)` so redelivery is a no-op.
 */
export const M23_IDEMPOTENCY_KEYS = {
  /** `(claimId, attemptIndex)`. */
  claimSubmit: (claimId: string, attemptIndex: number): string =>
    `claim-submit:${claimId}:${attemptIndex}`,
  /** `(claimId, attemptIndex)`. */
  claimSubmitRetry: (claimId: string, attemptIndex: number): string =>
    `claim-submit-retry:${claimId}:${attemptIndex}`,
  /** `(noeId)`. */
  noeSubmit: (noeId: string): string => `noe-submit:${noeId}`,
  /** `(notrId)`. */
  notrSubmit: (notrId: string): string => `notr-submit:${notrId}`,
  /** `(patientId, asOfServiceDate)`. */
  eligibilityRefresh: (patientId: string, asOfServiceDate: string): string =>
    `elig:${patientId}:${asOfServiceDate}`,
  /** `(claimId, validationRunId)`. */
  validationRun: (claimId: string, validationRunId: string): string =>
    `val:${claimId}:${validationRunId}`,
  /** `(eventId, targetClaimId)` — the §4.8 consumer idempotency tuple. */
  revalidateConsumer: (eventId: string, targetClaimId: string): string =>
    `reval:${eventId}:${targetClaimId}`,
  /** `(macJurisdiction, scanDay)`. */
  ackPull999: (macJurisdiction: string, at: Date): string =>
    `ack999:${macJurisdiction}:${dayBucket(at)}`,
  /** `(macJurisdiction, scanDay)`. */
  ackPull277ca: (macJurisdiction: string, at: Date): string =>
    `ack277ca:${macJurisdiction}:${dayBucket(at)}`,
} as const;

/**
 * The BullMQ job id for an M23 queue job: `m23:<queue>:<key>`. BullMQ refuses a custom id containing ':' unless
 * it has exactly three ':'-separated parts ("Custom Id cannot contain :"), so a composite dedupe key
 * (`eligibility.refresh`'s `patient:date:event`, `claim.submit.retry`'s `submission:attempt`) has its ':' folded to
 * '_' — the id stays deterministic, so a relay redelivery is still a BullMQ-level no-op.
 */
export function m23JobId(queueName: string, key: string): string {
  return `m23:${queueName}:${key.replaceAll(":", "_")}`;
}
