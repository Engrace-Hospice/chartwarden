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
  type AuditJobOpsDeps,
  runAuditFanout,
  runBuildExportSweepForOrg,
  runDestructionSweepForOrg,
  runRetentionScanForOrg,
} from "./audit-job-ops";

const EXPORT_SWEEP_CRON = "*/2 * * * *";
const DESTRUCTION_SWEEP_CRON = "*/10 * * * *";

/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M4_AUDIT_JOBS_PLATFORM_JOB_ID = "m4.audit_jobs";

export interface AuditOpsWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly ops: AuditJobOpsDeps;
}

/** One Worker per bound queue; the destruction sweep only when an eraser (destruction credential) exists. */
export function registerAuditOpsWorkers(deps: AuditOpsWorkerDeps): Worker[] {
  const { ops, connection } = deps;
  const workers: Worker[] = [
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
  return workers;
}

/** Register the repeatable triggers for the queues {@link registerAuditOpsWorkers} constructs. */
export async function scheduleAuditOpsJobs(
  connection: ConnectionOptions,
  opts: { exports: boolean; destruction: boolean },
): Promise<Queue[]> {
  const specs: { name: string; pattern: string }[] = [
    { name: AUDIT_QUEUES.retentionScan, pattern: AUDIT_JOB_SCHEDULES.retentionScan },
    ...(opts.exports ? [{ name: AUDIT_QUEUES.buildExport, pattern: EXPORT_SWEEP_CRON }] : []),
    ...(opts.destruction
      ? [{ name: AUDIT_QUEUES.executeDestruction, pattern: DESTRUCTION_SWEEP_CRON }]
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
