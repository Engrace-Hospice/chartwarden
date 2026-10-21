// apps/backend/src/modules/04-audit/jobs — M4-T11 BullMQ wiring for the audit jobs (§4.4).
//
// The thin, infra-touching adapter that turns @chartwarden/audit's pure job descriptors into running
// BullMQ workers + the two repeatable schedules. All job LOGIC lives in the package (and is
// unit-tested there against in-memory ports); this module only constructs `Worker`/`Queue` over a
// Redis/Valkey connection, so it is exercised in production wiring — never at import or in tests
// (constructing a Worker is what opens the connection; that happens only inside these functions).
import {
  AUDIT_JOB_SCHEDULES,
  AUDIT_QUEUES,
  type AuditJobAdapters,
  auditJobDescriptors,
} from "@chartwarden/audit";
import { type ConnectionOptions, Queue, Worker } from "bullmq";

/** Deps for wiring the audit workers: the Redis/Valkey connection + the bound infra adapters. */
export interface AuditWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly adapters: AuditJobAdapters;
  /** Worker concurrency (default 1 — audit jobs are I/O-light and ordering-sensitive). */
  readonly concurrency?: number;
}

/**
 * Construct one BullMQ `Worker` per audit queue, each driving the matching pure processor with the
 * job's `data`. Returns the workers so the composition root can `close()` them on shutdown. The
 * caller is responsible for the lifecycle; nothing here is invoked at import.
 */
export function registerAuditWorkers(deps: AuditWorkerDeps): Worker[] {
  const concurrency = deps.concurrency ?? 1;
  return auditJobDescriptors(deps.adapters).map(
    (descriptor) =>
      new Worker(descriptor.queue, async (job) => descriptor.process(job.data), {
        connection: deps.connection,
        concurrency,
      }),
  );
}

/**
 * Register the two repeatable audit schedules (§4.4): the daily retention scan and the quarterly
 * integrity sample. Event-triggered queues (execute_destruction, build_export, seal_partition) are
 * enqueued on demand by their callers, not scheduled here. Returns the schedule `Queue`s.
 */
export async function scheduleAuditJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const retentionScan = new Queue(AUDIT_QUEUES.retentionScan, { connection });
  const integritySample = new Queue(AUDIT_QUEUES.integritySample, { connection });
  await retentionScan.add(
    "scheduled",
    {},
    { repeat: { pattern: AUDIT_JOB_SCHEDULES.retentionScan }, removeOnComplete: true },
  );
  await integritySample.add(
    "scheduled",
    {},
    { repeat: { pattern: AUDIT_JOB_SCHEDULES.integritySample }, removeOnComplete: true },
  );
  return [retentionScan, integritySample];
}
