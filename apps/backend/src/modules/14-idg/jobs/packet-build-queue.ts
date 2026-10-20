// M14 on-demand packet build — the producer side. `POST /idg/meetings/:id/packets/build` flips the meeting to
// `packets_building` and, AFTER that tx commits, enqueues one `on-demand` job on the existing
// `idg.packets-cron` queue; the worker in `cron-workers.ts` runs `runOnDemandPacketBuild` for it.
import type { Queue } from "bullmq";
import { M14_QUEUE_PARAMS } from "./index";

export const ON_DEMAND_PACKET_BUILD_JOB = "on-demand";

/** Bound on `queue.add`: ioredis queues commands while Redis is down, so without this the request would hang. */
export const PACKET_BUILD_ENQUEUE_TIMEOUT_MS = 3_000;
/** The fixed backoff between the on-demand job's attempts (the cron's own `fixed 60s` row). */
export const PACKET_BUILD_RETRY_DELAY_MS = 60_000;

export interface OnDemandPacketBuildJob {
  readonly organizationId: string;
  readonly meetingId: string;
  /** The acting membership (ids only). Carried to the worker's log line; not on the outbox payloads (catalog shape). */
  readonly requestedByMembershipId?: string;
}

/** Structural port the route calls; unbound (in-memory service / no Redis) ⇒ the route behaves as before. */
export interface PacketBuildQueuePort {
  enqueue(job: OnDemandPacketBuildJob): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Redis job data is untrusted: accept only uuids, throw otherwise (the job fails, nothing is built). */
export function parseOnDemandPacketBuildJob(data: unknown): OnDemandPacketBuildJob {
  const d = (data ?? {}) as Record<string, unknown>;
  const { organizationId, meetingId, requestedByMembershipId } = d;
  if (
    !isUuid(organizationId) ||
    !isUuid(meetingId) ||
    (requestedByMembershipId !== undefined && !isUuid(requestedByMembershipId))
  ) {
    throw new Error("M14_PACKET_BUILD: invalid on-demand job data");
  }
  return {
    organizationId,
    meetingId,
    ...(requestedByMembershipId ? { requestedByMembershipId } : {}),
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`packet build enqueue timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** BullMQ adapter. A waiting/active/delayed job with the same id dedupes a double click. A job that already
 *  finished keeps its id (failed: `removeOnFail: false`, the M14 DLQ convention, so ops can inspect it), and BullMQ
 *  silently ignores `add` for a taken id, so a retained failed/completed job is removed first or "Retry build"
 *  would do nothing. (`-` not `:` in the id — BullMQ rejects `:` in custom ids.) */
export function createBullmqPacketBuildQueuePort(
  queue: Queue,
  opts: { timeoutMs?: number; retryDelayMs?: number } = {},
): PacketBuildQueuePort {
  const {
    timeoutMs = PACKET_BUILD_ENQUEUE_TIMEOUT_MS,
    retryDelayMs = PACKET_BUILD_RETRY_DELAY_MS,
  } = opts;
  return {
    enqueue: (job) =>
      withTimeout(
        (async () => {
          const jobId = `build-${job.organizationId}-${job.meetingId}`;
          const existing = await queue.getJob(jobId);
          if (existing) {
            const state = await existing.getState();
            if (state === "failed" || state === "completed") await existing.remove();
          }
          await queue.add(ON_DEMAND_PACKET_BUILD_JOB, job, {
            jobId,
            removeOnComplete: true,
            removeOnFail: false,
            attempts: M14_QUEUE_PARAMS.packetsBuild.attempts,
            backoff: { type: "fixed", delay: retryDelayMs },
          });
        })(),
        timeoutMs,
      ),
  };
}
