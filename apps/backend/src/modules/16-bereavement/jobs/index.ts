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
  // ADR-0109 D10 — the mailing program: a 5-minute sweep (drafts runs, re-sends a lost render hand-off, writes the activity log) and the render worker.
  mailingSweep: "m16-mailing-sweep",
  mailingGenerate: "m16-mailing-generate",
  // CW-BR-10 — the daily retention purge of the rendered mailing batch PDFs (a name-and-address list each). Dry run until the deployment switch is on.
  mailingFilePurge: "m16-mailing-file-purge",
} as const;

export type M16QueueName = (typeof M16_QUEUES)[keyof typeof M16_QUEUES];

/** §4.9 DLQ names — `removeOnFail: false` keeps each queue's failed set as the de facto DLQ (M20 precedent). */
export const M16_DLQ = {
  close13Months: "m16-close-13mo-dlq",
  anniversaryLookahead: "m16-anniversary-dlq",
  missDeadline: "m16-miss-deadline-dlq",
  unreachableDetector: "m16-unreachable-dlq",
  mailingSweep: "m16-mailing-sweep-dlq",
  mailingGenerate: "m16-mailing-generate-dlq",
  mailingFilePurge: "m16-mailing-file-purge-dlq",
} as const;

/** Repeatable job names (what a log line / BullMQ UI shows). */
export const M16_JOB_NAMES = {
  close13Months: "m16.close-13mo.cron",
  anniversaryLookahead: "m16.anniversary-lookahead.cron",
  missDeadline: "m16.miss-deadline.cron",
  unreachableDetector: "m16.unreachable-detector.cron",
  mailingSweep: "m16.mailing-sweep.cron",
  mailingGenerate: "m16.mailing-generate",
  mailingFilePurge: "m16.mailing-file-purge.cron",
} as const;

/** §4.9 schedules (cron patterns, evaluated in UTC by BullMQ). */
export const M16_JOB_SCHEDULES = {
  close13Months: "0 2 * * *",
  anniversaryLookahead: "0 6 * * *",
  missDeadline: "0 * * * *",
  unreachableDetector: "0 3 * * *",
  mailingSweep: "*/5 * * * *",
  mailingFilePurge: "30 4 * * *",
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
  mailingSweep: {
    priority: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 1,
  },
  // A render is the expensive step and the only one that decrypts addresses: a modest pool, retried, then the failed set (the DLQ) and a `failed` run.
  mailingGenerate: {
    priority: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 2,
  },
  // One daily pass over every org. A refused or failed pass retries, then lands in the failed set (the DLQ) and the platform's DLQ promotion alert fires.
  mailingFilePurge: {
    priority: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 300_000 },
    concurrency: 1,
  },
} as const;

/** §4.9 anniversary lookahead horizon. */
export const M16_ANNIVERSARY_LOOKAHEAD_DAYS = 14;

/** Per-org rows handled per tick (the next tick drains the rest; every pass is idempotent). */
export const M16_CRON_BATCH_LIMIT = 500;

/** ADR-0109 D10 — activity-log rows the sweep writes per transaction (set-based `INSERT ... SELECT`), and the chunk cap per run per tick. */
export const M16_MAILING_LOG_CHUNK = 500;
export const M16_MAILING_LOG_MAX_CHUNKS_PER_TICK = 100;
/** A run that has sat in `generating` this long lost its render hand-off (or its worker): the sweep re-sends it (idempotent by job id). */
export const M16_MAILING_STALE_GENERATING_MS = 10 * 60 * 1000;
/**
 * CW-BR-10 — the most files one org's purge pass may destroy. A pass whose plan is BIGGER is refused whole (nothing is deleted) and alarms: a first run over
 * a backlog is a human decision, made by raising `M16_MAILING_FILE_PURGE_MAX_PER_RUN` after the dry-run report has been read.
 */
export const M16_MAILING_FILE_PURGE_DEFAULT_MAX_PER_RUN = 50;
/** CW-BR-10 — the most not-yet-destroyed batch files the pass will even evaluate for one org; more is refused as too large to plan. */
export const M16_MAILING_FILE_PURGE_LIST_LIMIT = 1000;
/**
 * CW-BR-10 — EXECUTION IS DISABLED IN CODE. While this is `false` the purge is a DRY RUN whatever `M16_MAILING_FILE_PURGE_EXECUTE` says: the env switch alone
 * destroys nothing (the job logs the plan with `executeDisabledInCode: true` and boot warns). It is the ONLY thing to flip, and only after BOTH owner
 * decisions are implemented:
 *   1. the retention class and period: ADR-0004 / M16-F01 say the 13-month window must not trigger destruction before the 7-year clinical class, while this job's
 *      396/30/7-day defaults follow the `bereavement` document class (amend ADR-0004 / M16-F01 to a derived print file, or re-anchor the period);
 *   2. the destruction model: ARCHITECTURE §24.1 / §24.2 require retention-expired PHI to go through an approved M4 destruction request and certificate, and
 *      architecture wins over module specs and ADRs: a follow-up binds that gate (the M36 pattern) before this flips.
 * Only a dependency (`mailingFilePurge.executionSupported`), set by tests and never by the composition root, can enable the destroy path without it.
 */
export const MAILING_FILE_PURGE_EXECUTE_SUPPORTED = false;
