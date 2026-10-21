// M36 WP 5.7 (ADR-0089, PROPOSED) - the BullMQ shells of the export lifecycle's worker half.
//   · `m36.export.approved` (outbox) -> `buildM36ExportBuildConsumer` enqueues ONE `messaging.export_build` job {organizationId, jobId} (BullMQ job id =
//     the export job id, so a redelivery is a no-op) -> `registerM36ExportBuildWorker` runs the builder.
//   · `messaging.export_expiry_sweep` (hourly) fans out over the active orgs and expires every ready export past its link. Flag-independent.
// A build never throws for a build failure (the job row records the closed failure code); a throw here means the claim itself could not run, and
// BullMQ retries it (a retry after a successful claim finds the job past `approved` and does nothing).
// An approved job whose enqueue was lost (Redis flush) is re-enqueued by the hourly sweep once it is EXPORT_APPROVED_REENQUEUE_MINUTES old (the BullMQ job
// id is the export job id, so a live duplicate is a no-op; a failed leftover with that id is removed first so the add takes).
import {
  MESSAGING_JOB_SCHEDULES,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
} from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { ExportBuilder } from "./export-builder";
import { M36_EXPORT_EVENTS } from "./export-events";
import type { ExportExpirySweepResult } from "./export-expiry-sweep";

export interface ExportBuildJobData {
  readonly organizationId: string;
  readonly jobId: string;
}

export const M36_EXPORT_BUILD_CONSUMER = "m36.export-build" as const;

export type EnqueueExportBuild = (data: ExportBuildJobData) => Promise<void>;

function requireText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_EXPORT_BUILD_CONSUMER}: missing ${key}`);
  }
  return value;
}

/** Outbox consumer: an approved export becomes one build job. The tenant comes from the envelope, never the payload. */
export function buildM36ExportBuildConsumer(deps: {
  readonly enqueue: EnqueueExportBuild;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_EXPORT_BUILD_CONSUMER,
    consumerModule: "m36",
    eventTypes: [M36_EXPORT_EVENTS.approved],
    async handle(event: DispatchableOutboxEvent) {
      if (event.eventType !== M36_EXPORT_EVENTS.approved) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      // The aggregate is the job; the payload's own id must agree (a malformed event fails loudly and is redelivered).
      const jobId = requireText(payload, "jobId");
      if (jobId !== event.aggregateId)
        throw new Error(`${M36_EXPORT_BUILD_CONSUMER}: job id mismatch`);
      await deps.enqueue({ organizationId: event.organizationId, jobId });
    },
  };
}

/** The production enqueuer over the build queue. Returns the `Queue` to `close()` too. */
export function createExportBuildEnqueuer(connection: ConnectionOptions): {
  readonly enqueue: EnqueueExportBuild;
  readonly queue: Queue;
} {
  const queue = new Queue(MESSAGING_QUEUES.exportBuild, { connection });
  const { attempts, backoff } = MESSAGING_QUEUE_PARAMETERS[MESSAGING_QUEUES.exportBuild];
  return {
    queue,
    async enqueue(data) {
      const leftover = await queue.getJob(data.jobId);
      if (leftover && (await leftover.isFailed())) await leftover.remove();
      await queue.add("build", data, {
        jobId: data.jobId,
        attempts,
        backoff: { type: backoff.type, delay: backoff.baseMs },
        removeOnComplete: true,
      });
    },
  };
}

/** One build job: the builder returns its outcome (ready / failed / skipped); only an unexpected throw fails the BullMQ job. */
export interface ExportBuildFailureInfo {
  readonly jobId: string;
  readonly failureCode: string;
  readonly errorName: string;
}

export async function exportBuildJob(
  builder: Pick<ExportBuilder, "buildJob">,
  data: ExportBuildJobData,
  onFailed?: (info: ExportBuildFailureInfo) => void,
) {
  if (!data?.organizationId || !data?.jobId) throw new Error("export build: bad job data");
  const outcome = await builder.buildJob(data.organizationId, data.jobId);
  // Class and closed code only, never a message: an error text can carry content.
  if (outcome.outcome === "failed") {
    onFailed?.({
      jobId: data.jobId,
      failureCode: outcome.failureCode,
      errorName: outcome.errorName,
    });
  }
  return outcome;
}

export function registerM36ExportBuildWorker(deps: {
  readonly connection: ConnectionOptions;
  readonly builder: Pick<ExportBuilder, "buildJob">;
  readonly onFailed?: (info: ExportBuildFailureInfo) => void;
}): Worker[] {
  return [
    new Worker(
      MESSAGING_QUEUES.exportBuild,
      (job) => exportBuildJob(deps.builder, job.data as ExportBuildJobData, deps.onFailed),
      {
        connection: deps.connection,
        concurrency: MESSAGING_QUEUE_PARAMETERS[MESSAGING_QUEUES.exportBuild].concurrency,
      },
    ),
  ];
}

export interface M36ExportExpiryWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly expireForOrg: (orgId: string) => Promise<ExportExpirySweepResult>;
  /** Approved jobs old enough that their build job was probably lost; each is re-enqueued by `enqueue`. Both absent => no re-enqueue pass. */
  readonly staleApprovedForOrg?: (orgId: string) => Promise<readonly string[]>;
  readonly enqueue?: EnqueueExportBuild;
}

/** One tick: expire the ready exports past their link in every active org. An org failing fails the tick after the others ran. */
export async function exportExpiryTick(
  deps: Pick<
    M36ExportExpiryWorkerDeps,
    "activeOrgs" | "onError" | "expireForOrg" | "staleApprovedForOrg" | "enqueue"
  >,
): Promise<ExportExpirySweepResult & { readonly reenqueued: number }> {
  const totals = { expired: 0, timedOut: 0, reenqueued: 0 };
  await fanOutOrgs(deps, "export_expiry_sweep", async (organizationId) => {
    // The stale-approved pass runs even when the expiry throws (e.g. a failed object delete); the expiry error is rethrown after it.
    let expiryError: unknown;
    try {
      const result = await deps.expireForOrg(organizationId);
      totals.expired += result.expired;
      totals.timedOut += result.timedOut;
    } catch (error) {
      expiryError = error;
    }
    const enqueueErrors: unknown[] = [];
    if (deps.staleApprovedForOrg && deps.enqueue) {
      for (const jobId of await deps.staleApprovedForOrg(organizationId)) {
        try {
          await deps.enqueue({ organizationId, jobId });
          totals.reenqueued += 1;
        } catch (error) {
          enqueueErrors.push(error);
        }
      }
    }
    const errors = expiryError === undefined ? enqueueErrors : [expiryError, ...enqueueErrors];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "export expiry sweep failed");
  });
  return totals;
}

export function registerM36ExportExpiryWorker(deps: M36ExportExpiryWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.exportExpirySweep, () => exportExpiryTick(deps), {
      connection: deps.connection,
      concurrency: MESSAGING_QUEUE_PARAMETERS[MESSAGING_QUEUES.exportExpirySweep].concurrency,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36ExportExpiryJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.exportExpirySweep, { connection });
  await queue.add(
    "sweep",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.exportExpirySweep }, removeOnComplete: true },
  );
  return [queue];
}
