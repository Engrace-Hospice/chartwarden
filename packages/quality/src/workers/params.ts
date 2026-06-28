// @wardenx/quality · workers — the §4.8 PURE job catalog: queue names / params / DLQ / cron cadences /
// idempotency keys + the per-queue tenancy-scope marker. Pure data + thin types — NO `bullmq` import.
//
// The live BullMQ `Worker`/`Queue` construction binds at app boot in the M30 backend `jobs/m30-jobs.ts`
// adapter (the M33 `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts` / M34 `saas-jobs.ts`
// precedent): that thin, infra-touching layer turns these constants + the pure processors (this folder)
// into running workers over an injected Valkey connection. NOTHING here opens a connection — constructing
// a Worker is what opens Valkey, and that happens only in the backend adapter, never at import / in tests.
//
// §4.8 declares FOUR queues under the `m30.*` namespace + FOUR scheduled crons. Per M30-F17 (DR-022 /
// OPS-035) every queue carries an explicit DLQ, retry budget, and consumer-idempotency assertion (the
// §4.8 `processingLog` short-circuit each processor opens with — see `./ports.ts`).

/** The §4.8 BullMQ queue names (verbatim from the §4.8 table). */
export const M30_QUEUES = {
  /** `m30.measure_recompute` — recompute one `(measure, provider_entity, period)` HQRP value (§2.6 / §7.1). */
  measureRecompute: "m30.measure_recompute",
  /** `m30.cahps_export` — render (+optionally push) a month's decedent sample to the org's CAHPS vendor (§7.2). */
  cahpsExport: "m30.cahps_export",
  /** `m30.outbreak_detection` — run the ≥3-events/14d cluster detector for one surveillance event (§7.8 / D11). */
  outbreakDetection: "m30.outbreak_detection",
  /** `m30.risk_register_refresh` — REFRESH `risk_register_view` CONCURRENTLY for one org (§7.9 / D13). */
  riskRegisterRefresh: "m30.risk_register_refresh",
} as const;

export type M30QueueName = (typeof M30_QUEUES)[keyof typeof M30_QUEUES];

/** The §4.8 dead-letter queue names (one per queue; Ops drains via M1 `m1.queue.dlq_drain`). */
export const M30_DLQ = {
  measureRecompute: "m30.measure_recompute.dlq",
  cahpsExport: "m30.cahps_export.dlq",
  outbreakDetection: "m30.outbreak_detection.dlq",
  riskRegisterRefresh: "m30.risk_register_refresh.dlq",
} as const;

/**
 * The §4.8 BullMQ standard parameter set per queue (the §4.8 table's worker-concurrency + attempts/backoff
 * columns), pure data so the boot-time `Worker` construction consumes one source of truth. `removeOnFail`
 * stays false so an exhausted job is retained for DLQ promotion. Backoff is exponential with an initial
 * `delayMs` (the §4.8 low bound) capped at `maxDelayMs` (the high bound).
 */
export const M30_QUEUE_PARAMS = {
  /** §4.8 — 4/node (max 12 cluster-wide), exp 30s→10min, 6 attempts; 6th failure → critical Ops alert + DLQ. */
  measureRecompute: {
    priority: 4,
    attempts: 6,
    backoff: { type: "exponential", delayMs: 30_000, maxDelayMs: 600_000 },
    concurrency: 4,
    removeOnComplete: { count: 500 },
    removeOnFail: false,
    dlq: M30_DLQ.measureRecompute,
  },
  /** §4.8 — 2/node, exp 1min→30min, 4 attempts; 4th failure → `cahps_decedent_sample.status='export_failed'` + DLQ. */
  cahpsExport: {
    priority: 5,
    attempts: 4,
    backoff: { type: "exponential", delayMs: 60_000, maxDelayMs: 1_800_000 },
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M30_DLQ.cahpsExport,
  },
  /** §4.8 — 1/node serialized-per-org, exp 10s→5min, 5 attempts; 5th failure → compensating re-emit + DLQ. */
  outbreakDetection: {
    priority: 3, // an outbreak is patient-safety critical — high priority, serialized per org
    attempts: 5,
    backoff: { type: "exponential", delayMs: 10_000, maxDelayMs: 300_000 },
    concurrency: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M30_DLQ.outbreakDetection,
  },
  /** §4.8 — 1/node serialized-per-org, exp 30s→10min, 3 attempts; 3rd failure → view served stale + DLQ. */
  riskRegisterRefresh: {
    priority: 6,
    attempts: 3,
    backoff: { type: "exponential", delayMs: 30_000, maxDelayMs: 600_000 },
    concurrency: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: false,
    dlq: M30_DLQ.riskRegisterRefresh,
  },
} as const;

/**
 * The §4.8 cron schedules (registered as BullMQ repeatables in the backend `m30-crons` adapter). All four
 * fire at fixed UTC times; the boot scheduler owns the cron tick, each handler (this folder) owns the work.
 */
export const M30_JOB_SCHEDULES = {
  /** `m30.nightly_recompute` — 03:15 UTC daily: enqueue a full-org recompute for every active org (§7.1). */
  nightlyRecompute: "15 3 * * *",
  /** `m30.cahps_monthly_sample` — 02:00 UTC day-2 of month: build the prior-month decedent sample (§7.2). */
  cahpsMonthlySample: "0 2 2 * *",
  /** `m30.risk_register_refresh` — 04:00 UTC daily: force-refresh `risk_register_view` for every org (§7.9). */
  riskRegisterRefresh: "0 4 * * *",
  /** `m30.sra_reminders` — 09:00 UTC daily: evaluate the 90/60/30/7-day SRA reminder calendar (§4.9). */
  sraReminders: "0 9 * * *",
} as const;

// ── §4.8 idempotency keys (the BullMQ jobId / §2.6 dedup oracles) ───────────────────────────────────────

/** `m30.measure_recompute` jobId — `(orgId, measureCode, periodEnd, computeVersion)` (§4.8 / V-8). */
export function measureRecomputeJobId(input: {
  organizationId: string;
  measureCode: string;
  periodEnd: string;
  computeVersion: string;
}): string {
  return `measure_recompute:${input.organizationId}:${input.measureCode}:${input.periodEnd}:${input.computeVersion}`;
}

/** `m30.cahps_export` jobId — `(orgId, samplePeriod.start, samplePeriod.end, vendorBindingId)` (§4.8). */
export function cahpsExportJobId(input: {
  organizationId: string;
  samplePeriodStart: string;
  samplePeriodEnd: string;
  vendorBindingId: string;
}): string {
  return `cahps_export:${input.organizationId}:${input.samplePeriodStart}:${input.samplePeriodEnd}:${input.vendorBindingId}`;
}

/** `m30.outbreak_detection` jobId — `(orgId, surveillanceEventId)` (§4.8). */
export function outbreakDetectionJobId(input: {
  organizationId: string;
  surveillanceEventId: string;
}): string {
  return `outbreak_detection:${input.organizationId}:${input.surveillanceEventId}`;
}

/** `m30.risk_register_refresh` jobId — `(orgId, dateBucket)` (the day collapses repeat refreshes, §4.8). */
export function riskRegisterRefreshJobId(input: {
  organizationId: string;
  dateBucket: string;
}): string {
  return `risk_register_refresh:${input.organizationId}:${input.dateBucket}`;
}

// ── the per-queue tenancy envelope the live wiring runs each processor inside ────────────────────────────

/** The tenancy envelope a job runs inside (F09). The backend adapter wraps each processor accordingly. */
export type M30JobScope = "org" | "platform";

/**
 * The required tenancy envelope per queue. All four §4.8 work queues are ORG-scoped — each job names one
 * org and the backend adapter wraps the processor in `withOrgContext(orgId)` so Postgres RLS scopes every
 * statement to `app.org_id` (never platform bypass). The CRON handlers (`./crons.ts`) instead run a
 * PLATFORM-scoped enumeration to list the active orgs, then fan ORG-scoped jobs out onto these queues.
 */
export const M30_QUEUE_SCOPE: Record<M30QueueName, M30JobScope> = {
  [M30_QUEUES.measureRecompute]: "org",
  [M30_QUEUES.cahpsExport]: "org",
  [M30_QUEUES.outbreakDetection]: "org",
  [M30_QUEUES.riskRegisterRefresh]: "org",
};

/**
 * A pure processor: the body a `Worker(queue, processor, …)` runs — `(jobData) => Promise<result>` with the
 * worker's ports already CLOSED OVER by the backend adapter (so the run sits inside the right tenancy
 * envelope). Mirrors the M33 `M33JobProcessor` shape — the package holds the logic; the adapter binds it.
 */
export type M30JobProcessor<Data, Result> = (data: Data) => Promise<Result>;
