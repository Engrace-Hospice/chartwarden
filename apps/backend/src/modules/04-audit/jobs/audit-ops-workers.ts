// apps/backend/src/modules/04-audit/jobs/audit-ops-workers.ts — GAP-014 the BullMQ shell over the bound
// M4 audit job ops (`./audit-job-ops.ts`). Constructed by the composition root next to the M34 workers,
// only with a Valkey connection (constructing a Worker opens it — never at import, never in tests).
//
// build_export and execute_destruction are SWEEPS (every few minutes) rather than per-request jobs: the
// export/approve routes only persist a row, and a sweep needs no enqueue seam in those routes and
// survives a lost job. retention_scan is the daily §4.4 schedule from @wardenx/audit.
import { AUDIT_JOB_SCHEDULES, AUDIT_QUEUES } from "@wardenx/audit";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type AuditIntegrityDeps,
  runIntegritySampleForOrg,
  runSealPartitionsForOrg,
} from "./audit-integrity-job";
import {
  type AuditJobOpsDeps,
  runAuditFanout,
  runBuildExportSweepForOrg,
  runDestructionSweepForOrg,
  runLegalHoldMaterialiseForOrg,
  runRetentionScanForOrg,
} from "./audit-job-ops";

const EXPORT_SWEEP_CRON = "*/2 * * * *";
const DESTRUCTION_SWEEP_CRON = "*/10 * * * *";
/** GAP-008 - the legal-hold overlay materialiser (a sweep, like export / destruction). Cheap when caught up. */
export const LEGAL_HOLD_MATERIALISE_QUEUE = "audit.legal_hold_materialise";
const LEGAL_HOLD_MATERIALISE_CRON = "*/5 * * * *";

/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M4_AUDIT_JOBS_PLATFORM_JOB_ID = "m4.audit_jobs";

export interface AuditOpsWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly ops: AuditJobOpsDeps;
  /** The sealed audit hash chain + sampled verification (§4.4). Absent ⇒ neither queue is constructed. */
  readonly integrity?: AuditIntegrityDeps;
}

/** One Worker per bound queue; the destruction sweep only when an eraser (destruction credential) exists. */
export function registerAuditOpsWorkers(deps: AuditOpsWorkerDeps): Worker[] {
  const { ops, connection } = deps;
  const workers: Worker[] = [
    // GAP-008: always constructed (it needs only the tenant pool) - holds must be materialised whether or not a destruction
    // credential is provisioned, because reporting and the DELETE guard read the overlay.
    new Worker(
      LEGAL_HOLD_MATERIALISE_QUEUE,
      () =>
        runAuditFanout(
          ops.listOrgs,
          (o) => runLegalHoldMaterialiseForOrg(ops, o),
          "legal_hold_materialise",
        ),
      { connection, concurrency: 1 },
    ),
    new Worker(
      AUDIT_QUEUES.retentionScan,
      () => runAuditFanout(ops.listOrgs, (o) => runRetentionScanForOrg(ops, o), "retention_scan"),
      { connection, concurrency: 1 },
    ),
  ];
  if (ops.objectStore) {
    workers.push(
      new Worker(
        AUDIT_QUEUES.buildExport,
        () =>
          runAuditFanout(ops.listOrgs, (o) => runBuildExportSweepForOrg(ops, o), "build_export"),
        { connection, concurrency: 1 },
      ),
    );
  }
  if (ops.eraserPorts) {
    workers.push(
      new Worker(
        AUDIT_QUEUES.executeDestruction,
        () =>
          runAuditFanout(
            ops.listOrgs,
            (o) => runDestructionSweepForOrg(ops, o),
            "execute_destruction",
          ),
        { connection, concurrency: 1 },
      ),
    );
  }
  const { integrity } = deps;
  if (integrity) {
    workers.push(
      new Worker(
        AUDIT_QUEUES.sealPartition,
        () =>
          runAuditFanout(
            integrity.listOrgs,
            (o) => runSealPartitionsForOrg(integrity, o),
            "seal_partition",
          ),
        { connection, concurrency: 1 },
      ),
      // A mismatch makes the per-org run throw; runAuditFanout re-raises (AggregateError) AFTER every
      // other org was checked, so the job FAILS — it never reports green over a broken chain.
      new Worker(
        AUDIT_QUEUES.integritySample,
        () =>
          runAuditFanout(
            integrity.listOrgs,
            (o) => runIntegritySampleForOrg(integrity, o),
            "integrity_sample",
          ),
        { connection, concurrency: 1 },
      ),
    );
  }
  return workers;
}

/** Register the repeatable triggers for the queues {@link registerAuditOpsWorkers} constructs. */
export async function scheduleAuditOpsJobs(
  connection: ConnectionOptions,
  opts: { exports: boolean; destruction: boolean; integrity?: boolean },
): Promise<Queue[]> {
  const specs: { name: string; pattern: string }[] = [
    { name: LEGAL_HOLD_MATERIALISE_QUEUE, pattern: LEGAL_HOLD_MATERIALISE_CRON },
    { name: AUDIT_QUEUES.retentionScan, pattern: AUDIT_JOB_SCHEDULES.retentionScan },
    ...(opts.exports ? [{ name: AUDIT_QUEUES.buildExport, pattern: EXPORT_SWEEP_CRON }] : []),
    ...(opts.destruction
      ? [{ name: AUDIT_QUEUES.executeDestruction, pattern: DESTRUCTION_SWEEP_CRON }]
      : []),
    ...(opts.integrity
      ? [
          { name: AUDIT_QUEUES.sealPartition, pattern: AUDIT_JOB_SCHEDULES.sealPartition },
          { name: AUDIT_QUEUES.integritySample, pattern: AUDIT_JOB_SCHEDULES.integritySample },
        ]
      : []),
  ];
  const queues: Queue[] = [];
  for (const { name, pattern } of specs) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}
