// apps/backend/src/modules/28-fhir/jobs/queues.ts — the M28 §4.8 BullMQ queue + cron catalog (GAP-084).
//
// Six of the spec's seven queues are built here: the bulk-export worker, its sweeper, the inbound SLA watcher
// and the inbound payload-destruction worker, the client-session sweeper and the capability-snapshot validator.
// `fhir.jwks-refresh` is deliberately NOT built: it is the request-path JWKS fetch + 5-minute cache in
// `routes/token-mint.ts` (spec changelog 2026-10-06). BullMQ job ids and queue names must not contain ':'.

/** The platform job id the active-org enumerator enters `withPlatformContext` under (must be allowlisted). */
export const M28_PLATFORM_JOB_ID = "m28-fhir-workers";

export const M28_QUEUES = {
  /** §4.8 — event-driven: one job per accepted `$export`; 1 per backend node's concurrency lane is not needed
   *  because the per-client lock is the DB `accepted -> in_progress` claim, not a Valkey lock. */
  bulkExport: "fhir.bulk-export",
  /** §4.8 — cron: `completed -> expired` past `expires_at` + MinIO purge; also recovers orphaned jobs. */
  bulkExportSweeper: "fhir.bulk-export-sweeper",
  /** §4.8 — cron: `pending -> expired` past `inbound_review_sla_hours`; raises the M36 alert. */
  inboundSlaWatch: "fhir.inbound-sla-watch",
  /** §4.8 — cron: shreds the payload of `rejected`/`expired` proposals once the 30-day retention has run. */
  inboundPayloadDestruction: "fhir.inbound-payload-destruction",
  /** §4.8 — cron: deletes `fhir_client_session` rows past their retention. */
  clientSessionSweeper: "fhir.client-session-sweeper",
  /** §4.8 — cron hourly: persists (once per release) + re-verifies the signed `fhir_capability_snapshot`. */
  capabilitySnapshotValidator: "fhir.capability-snapshot-validator",
} as const;

export const M28_JOB_SCHEDULES = {
  /** §4.8 — every 15 minutes. */
  bulkExportSweeper: "*/15 * * * *",
  /** §4.8 — every 5 minutes. */
  inboundSlaWatch: "*/5 * * * *",
  /**
   * §4.8 schedules destruction PER ROW at +30 days. A repeatable sweep over the due rows is the same outcome
   * without one delayed job per proposal (a delayed job is lost with the Valkey it lives in; the row's
   * `payload_erase_scheduled_at` is durable). Hourly bounds the overshoot past +30d to an hour.
   */
  inboundPayloadDestruction: "35 * * * *",
  /** §4.8 — every 5 minutes. */
  clientSessionSweeper: "*/5 * * * *",
  /** §4.8 — hourly. */
  capabilitySnapshotValidator: "17 * * * *",
} as const;

/** §2.2 — the NDJSON outputs live exactly this long after completion (`FHIR_BULK_EXPORT_TTL_HOURS`). */
export const PRESIGNED_OUTPUT_TTL_SECONDS = 15 * 60;

/** §2.4 / §3.7 — a rejected or expired proposal's payload is shredded this long after the decision. */
export const INBOUND_PAYLOAD_RETENTION_DAYS = 30;

/** §8.4 — `fhir_client_session` is `operational`: 90 days hot after expiry, then routine purge. */
export const CLIENT_SESSION_RETENTION_DAYS = 90;

/** Rows a single sweep tick touches per org. A backlog drains over successive ticks, never in one query. */
export const SWEEP_BATCH_LIMIT = 200;

/** Patients read per page while projecting an export (the M5 enumeration is keyset-paged). */
export const EXPORT_PATIENT_PAGE_SIZE = 200;

/**
 * Hard ceiling on resources one export job may hold. The NDJSON of a job is assembled in memory before it is
 * put (the S3 port is a single PUT), so an unbounded job would be an unbounded allocation. A job over the cap
 * FAILS with a reason that tells the client to narrow `_type` / `_since`; it is never silently truncated (a
 * truncated export that reports `completed` is a disclosure-accounting lie).
 */
export const EXPORT_MAX_RESOURCES_PER_JOB = 250_000;

/** How long an `accepted` job may sit before the sweeper re-enqueues it (the producer's enqueue was lost). */
export const ORPHAN_ACCEPTED_AFTER_MS = 2 * 60 * 1000;

/** How long a job may stay `in_progress` before the sweeper declares the worker dead and fails it. */
export const STALLED_IN_PROGRESS_AFTER_MS = 60 * 60 * 1000;

/** An `accepted` job older than this is stale: it is cancelled, not run (also releases the client's slot). */
export const ABANDON_ACCEPTED_AFTER_MS = 24 * 60 * 60 * 1000;
