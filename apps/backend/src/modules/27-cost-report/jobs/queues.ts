// apps/backend/src/modules/27-cost-report/jobs/queues.ts — the M27 §4.8 BullMQ queue catalog.
//
// @wardenx/cost-report ships the PURE domain (lifecycle reducer, worksheets, allocation, ECR, validation,
// money/snapshot) but — unlike @wardenx/quality, which ships `M30_QUEUES`/`M30_QUEUE_PARAMS` in the package
// `workers/*` subtree — it does NOT ship a queue/param catalog (P1 was "no BullMQ"). So the §4.8 catalog is
// defined LOCALLY here (the task's "define the M27 queue param catalog locally if not in @wardenx/cost-report"),
// distinct from the prose docs. These constants are the single source of truth the worker construction
// (`m27-jobs.ts`) + the composition-root producer (`routes/write-service-drizzle.ts`'s `RecomputeEnqueuePort`)
// agree on: a worker on `M27_QUEUES.trialBalancePull` consumes the jobs the write-service enqueues onto the
// SAME bare wire name (`"trial-balance-pull"`).
//
// IMPORTANT (wire-name parity): the §4.8 spec table prefixes each queue with `cost-report:`; the already-built
// write-service producer enqueues onto the BARE names (`"trial-balance-pull"`, `"allocation-recompute"`, …).
// Since the producer is a SHARED file that must not be edited, the constants below are the bare names the
// producer actually uses — that is what keeps the producer↔consumer wire names 1:1.

/** The §4.8 backoff envelope (kept local so the catalog takes no specific bullmq type-export dependency). */
export interface M27BackoffOptions {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

/** The seven §4.8 WORK queues (the producer fans org-scoped jobs onto these; the workers consume them). */
export const M27_QUEUES = {
  /** Pull trial balance from Xero (§4.8). */
  trialBalancePull: "trial-balance-pull",
  /** Pull wage data from Gusto (§4.8; only when wage_source=gusto). */
  wageDataPull: "wage-data-pull",
  /** Re-aggregate statistics from the M6/M8/M23 seams (§4.8). */
  statisticsRefresh: "statistics-refresh",
  /** Step-down B + apportionment C/D + settlement E-1 (§4.8). The producer's wire name is `allocation-recompute`. */
  costAllocationRecompute: "allocation-recompute",
  /** Execute the rule library against the current cost-report state (§4.8). */
  validationRun: "validation-run",
  /** Generate ECR + PI files; route to M22 for storage (§4.8). */
  ecrGeneration: "ecr-generation",
  /** Build the snapshot row content-hash; insert with the prior_snapshot_id chain (§4.8). */
  snapshotBuilder: "snapshot-builder",
} as const;

export type M27QueueName = (typeof M27_QUEUES)[keyof typeof M27_QUEUES];

/**
 * The §4.8 cron queue (every 6 hours): scan all open compliance windows; emit tier alerts on threshold
 * breach. Distinct wire name from the WORK queues so a cron tick is never delivered to a per-org worker.
 */
export const M27_CRON_QUEUES = {
  filingDeadlineScan: "filing-deadline-scan",
} as const;

export type M27CronQueueName = (typeof M27_CRON_QUEUES)[keyof typeof M27_CRON_QUEUES];

/** The §4.8 cron schedules (UTC). Filing-deadline scan runs every 6 hours (cron `0` + step-6 hour field). */
export const M27_JOB_SCHEDULES = {
  filingDeadlineScan: "0 */6 * * *",
} as const;

/** One queue's §4.8 runtime parameters: worker concurrency + the producer-side retry/backoff envelope. */
export interface M27QueueParam {
  /** BullMQ `Worker` concurrency (the only param the worker constructor consumes). */
  readonly concurrency: number;
  /** Bounded retries (the producer applies this on `Queue.add`; surfaced here as the §4.8 catalog). */
  readonly attempts: number;
  /** Exponential backoff (the producer applies this on `Queue.add`). */
  readonly backoff: M27BackoffOptions;
}

/** Exponential backoff with the standard 5s base (the M27 retry envelope). */
const EXPONENTIAL = (delay = 5000): M27BackoffOptions => ({ type: "exponential", delay });

/**
 * The §4.8 queue param catalog — concurrency + bounded-retry/backoff per queue, transcribed from the spec
 * §4.8 table. The worker construction reads `.concurrency`; the producer's `RecomputeEnqueuePort` adapter
 * reads `.attempts`/`.backoff` when it calls `Queue.add` (so the retry envelope lives in one home).
 */
export const M27_QUEUE_PARAMS = {
  // 4 (per-tenant serialized via Valkey mutex) | exponential, 6 retries | (costReportId, source, dayBucket)
  trialBalancePull: { concurrency: 4, attempts: 6, backoff: EXPONENTIAL() },
  // 4 (per-tenant serialized) | exponential, 6 retries | (costReportId, source, dayBucket)
  wageDataPull: { concurrency: 4, attempts: 6, backoff: EXPONENTIAL() },
  // 8 | exponential, 4 retries | (costReportId, asOfTimestamp)
  statisticsRefresh: { concurrency: 8, attempts: 4, backoff: EXPONENTIAL() },
  // 4 | exponential, 4 retries | (costReportId, snapshotOfInputsHash)
  costAllocationRecompute: { concurrency: 4, attempts: 4, backoff: EXPONENTIAL() },
  // 4 | exponential, 4 retries | (costReportId, ruleSetVersion, runTriggerId)
  validationRun: { concurrency: 4, attempts: 4, backoff: EXPONENTIAL() },
  // 2 (single-flight per cost report) | exponential, 8 retries | (submissionId)
  ecrGeneration: { concurrency: 2, attempts: 8, backoff: EXPONENTIAL() },
  // 1 (serialized in submit transaction context) | exponential, 4 retries | (costReportId, version, reason)
  snapshotBuilder: { concurrency: 1, attempts: 4, backoff: EXPONENTIAL() },
  // 1 (cron, every 6 hours) | exponential, 2 retries | (scanRunDate)
  filingDeadlineScan: { concurrency: 1, attempts: 2, backoff: EXPONENTIAL() },
} as const satisfies Record<string, M27QueueParam>;

// ── §4.8 idempotency keys (the producer dedupe-key shapes — keyed exactly per the spec table) ───────────

/** The day bucket (UTC `yyyy-mm-dd`) the import dedupe keys quantize on (one pull per source per day). */
function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The §4.8 idempotency-key builders. Each yields the canonical dedupe key for its queue so the producer's
 * `RecomputeEnqueuePort` and any worker-side replay guard agree on identity. PHi-free (D18); ids + buckets.
 */
export const M27_IDEMPOTENCY_KEYS = {
  /** `(costReportId, source, dayBucket)`. */
  trialBalancePull: (costReportId: string, source: string, at: Date): string =>
    `tb:${costReportId}:${source}:${dayBucket(at)}`,
  /** `(costReportId, source, dayBucket)`. */
  wageDataPull: (costReportId: string, source: string, at: Date): string =>
    `wage:${costReportId}:${source}:${dayBucket(at)}`,
  /** `(costReportId, asOfTimestamp)`. */
  statisticsRefresh: (costReportId: string, asOfTimestamp: string): string =>
    `stats:${costReportId}:${asOfTimestamp}`,
  /** `(costReportId, snapshotOfInputsHash)`. */
  costAllocationRecompute: (costReportId: string, snapshotOfInputsHash: string): string =>
    `alloc:${costReportId}:${snapshotOfInputsHash}`,
  /** `(costReportId, ruleSetVersion, runTriggerId)`. */
  validationRun: (costReportId: string, ruleSetVersion: number, runTriggerId: string): string =>
    `val:${costReportId}:${ruleSetVersion}:${runTriggerId}`,
  /** `(submissionId)`. */
  ecrGeneration: (submissionId: string): string => `ecr:${submissionId}`,
  /** `(costReportId, version, reason)`. */
  snapshotBuilder: (costReportId: string, version: number, reason: string): string =>
    `snap:${costReportId}:${version}:${reason}`,
  /** `(scanRunDate)`. */
  filingDeadlineScan: (scanRunDate: Date): string => `scan:${dayBucket(scanRunDate)}`,
} as const;
