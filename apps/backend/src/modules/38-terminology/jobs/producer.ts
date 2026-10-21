import type { FollowUpPort, LoadableSystemId } from "@chartwarden/terminology-loader";
// apps/backend/src/modules/38-terminology/jobs/producer.ts — the BullMQ producer for the §4.3 queues (GAP-108).
// Implements both the loader's {@link FollowUpPort} (what an activation owes) and the admin routes'
// {@link TerminologyJobProducer}. Job ids are deterministic per (queue, version) so a repeated enqueue while the
// first is still queued/active is a no-op; completed jobs are removed so a later resume is accepted.
import { type ConnectionOptions, Queue } from "bullmq";
import type { TerminologyJobProducer } from "../jobs-ports";
import {
  TERMINOLOGY_JOB_ATTEMPTS,
  TERMINOLOGY_JOB_BACKOFF_MS,
  TERMINOLOGY_QUEUES,
  jobIds,
} from "./queues";

const JOB_OPTIONS = {
  attempts: TERMINOLOGY_JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: TERMINOLOGY_JOB_BACKOFF_MS },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

export interface TerminologyProducer extends FollowUpPort, TerminologyJobProducer {
  /** Queue the next embeddings slice under a fresh job id (the per-run cap left concepts un-embedded). */
  continueEmbeddings(system: LoadableSystemId, versionId: string | null): Promise<void>;
  /** The queues to close on shutdown. */
  readonly queues: readonly Queue[];
}

/** Build the producer over a Valkey connection. */
export function buildTerminologyProducer(connection: ConnectionOptions): TerminologyProducer {
  const load = new Queue(TERMINOLOGY_QUEUES.loadVersion, { connection });
  const expansions = new Queue(TERMINOLOGY_QUEUES.refreshExpansions, { connection });
  const embeddings = new Queue(TERMINOLOGY_QUEUES.refreshEmbeddings, { connection });
  const scan = new Queue(TERMINOLOGY_QUEUES.tenantDeprecationScan, { connection });

  return {
    queues: [load, expansions, embeddings, scan],

    async enqueueLoadVersion(versionId: string, activate: boolean) {
      await load.add(
        "load",
        { versionId, activate },
        { ...JOB_OPTIONS, jobId: jobIds.load(versionId) },
      );
    },
    async enqueueRefreshExpansions(system: LoadableSystemId, versionId: string) {
      await expansions.add(
        "refresh",
        { system, versionId },
        { ...JOB_OPTIONS, jobId: jobIds.expansions(system, versionId) },
      );
    },
    async enqueueRefreshEmbeddings(system: LoadableSystemId, versionId: string) {
      await embeddings.add(
        "refresh",
        { system, versionId },
        { ...JOB_OPTIONS, jobId: jobIds.embeddings(system, versionId) },
      );
    },
    async continueEmbeddings(system: LoadableSystemId, versionId: string | null) {
      await embeddings.add(
        "refresh",
        { system, versionId },
        {
          ...JOB_OPTIONS,
          jobId: `${jobIds.embeddings(system, versionId ?? "active")}-c${Date.now()}`,
        },
      );
    },
    async enqueueTenantDeprecationScan(
      system: LoadableSystemId,
      versionId: string,
      effectiveFrom: string,
    ) {
      await scan.add(
        "scan",
        { system, versionId, effectiveFrom },
        { ...JOB_OPTIONS, jobId: jobIds.scan(versionId) },
      );
    },
  };
}
