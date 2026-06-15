// @wardenx/audit — Audit job descriptor registry (M4-T11, §4.4).
//
// Maps each queue name to the processor invocation it runs, given the bound infra adapters. This is
// the BullMQ-free seam between the pure processors and the worker wiring: the app composition root
// turns each descriptor into a `new Worker(queue, job => descriptor.process(job.data), ...)`, while
// this mapping itself stays pure data so it is unit-tested without Redis (the wiring's one untested
// line is the `new Worker` construction). Per-job inputs arrive as the BullMQ job's `data`; the
// scheduled jobs (retention scan, integrity sample) ignore it.
import type { DestructionRun } from "../lifecycle/destruction";
import {
  type BuildExportPorts,
  type ExecuteDestructionPorts,
  type IntegritySamplePorts,
  type RetentionScanPorts,
  type SealPartitionPorts,
  runBuildExport,
  runExecuteDestruction,
  runIntegritySample,
  runRetentionScan,
  runSealPartition,
} from "./processors";
import type { ExportRequest } from "../export/index";
import { AUDIT_QUEUES, type AuditQueueName } from "./queues";

/** The infra adapters every audit worker binds (production Drizzle/MinIO/Valkey, or in-memory). */
export interface AuditJobAdapters {
  readonly retentionScan: RetentionScanPorts;
  readonly executeDestruction: ExecuteDestructionPorts;
  readonly integritySample: IntegritySamplePorts;
  readonly buildExport: BuildExportPorts;
  readonly sealPartition: SealPartitionPorts;
}

/** Job payload for `audit.build_export` (the export id + the requested format/watermark). */
export interface BuildExportJobData {
  readonly exportId: string;
  readonly request: Pick<ExportRequest, "format" | "watermark">;
}

/** Job payload for `audit.seal_partition` (Phase 2). */
export interface SealPartitionJobData {
  readonly partition: string;
  readonly organizationId: string | null;
}

/** One queue's processor invocation, ready for a BullMQ worker to drive with the job's `data`. */
export interface AuditJobDescriptor {
  readonly queue: AuditQueueName;
  process(data: unknown): Promise<unknown>;
}

/**
 * Build the descriptor list binding each audit queue to its processor over the given adapters.
 * `audit.archive` is omitted — it is Module 1's partition-tiering mechanism, not an M4 processor.
 */
export function auditJobDescriptors(adapters: AuditJobAdapters): AuditJobDescriptor[] {
  return [
    {
      queue: AUDIT_QUEUES.retentionScan,
      process: () => runRetentionScan(adapters.retentionScan),
    },
    {
      queue: AUDIT_QUEUES.executeDestruction,
      process: (data) => runExecuteDestruction(data as DestructionRun, adapters.executeDestruction),
    },
    {
      queue: AUDIT_QUEUES.integritySample,
      process: () => runIntegritySample(adapters.integritySample),
    },
    {
      queue: AUDIT_QUEUES.buildExport,
      process: (data) => {
        const { exportId, request } = data as BuildExportJobData;
        return runBuildExport(exportId, request, adapters.buildExport);
      },
    },
    {
      queue: AUDIT_QUEUES.sealPartition,
      process: (data) => {
        const { partition, organizationId } = data as SealPartitionJobData;
        return runSealPartition(partition, organizationId, adapters.sealPartition);
      },
    },
  ];
}
