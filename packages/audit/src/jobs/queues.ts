// @chartwarden/audit — Audit job queue catalog (M4-T11, M4 spec §4.4).
//
// The canonical names + cadences of the six audit background jobs. Module 1 owns the
// `audit.archive` partition-tiering MECHANISM; Module 4 owns the retention/destruction/integrity/
// export POLICY that drives it (§2.4 "M1 owns the worker, M4 owns the policy"). These constants are
// the single source the BullMQ wiring (apps/backend/src/modules/04-audit/jobs) registers workers
// and repeatable schedules against — pure data, no BullMQ import (so the package stays infra-free).

/** The six audit queue names (§4.4). `sealPartition` is Phase 2 (flag-gated, inert until enabled). */
export const AUDIT_QUEUES = {
  /** M1-owned mechanism: tier closed partitions hot→warm (MinIO) per retention class. */
  archive: "audit.archive",
  /** Daily: find expired partitions/objects → open pending destruction certs (skip held/Part 2). */
  retentionScan: "audit.retention_scan",
  /** On cert approval: partition detach + crypto erase; Part 2 rows → partial_refused. */
  executeDestruction: "audit.execute_destruction",
  /** Phase 2 (on partition close, flag-gated): compute + store the hash-chain seal. */
  sealPartition: "audit.seal_partition",
  /** Quarterly: sample live events vs pgBackRest backup; alert on mismatch. */
  integritySample: "audit.integrity_sample",
  /** On export request: render the watermarked artifact to MinIO. */
  buildExport: "audit.build_export",
} as const;

/** A queue name from the catalog. */
export type AuditQueueName = (typeof AUDIT_QUEUES)[keyof typeof AUDIT_QUEUES];

/**
 * The repeat cadence for the two scheduled jobs, as cron expressions (UTC). The scheduler in the
 * app wiring registers these as BullMQ repeatable jobs; the rest are event-triggered.
 */
export const AUDIT_JOB_SCHEDULES = {
  /** Monthly, 03:30 UTC on the 2nd — the M1-owned `audit.archive` cold-tier job (GAP-113). */
  archive: "30 3 2 * *",
  /** Daily at 02:15 UTC — the nightly retention window (§4.4, §12.6). */
  retentionScan: "15 2 * * *",
  /** Monthly, 04:00 UTC on the 3rd — seal the closed month(s) (hash-chain flag gated, §4.4). */
  sealPartition: "0 4 3 * *",
  /** Quarterly: 03:30 UTC on the 1st of Jan/Apr/Jul/Oct (§4.4 integrity sample). */
  integritySample: "30 3 1 1,4,7,10 *",
} as const;
