// M34 `tenant.provision` job visibility + retry. The outbox consumer (outbox-consumers/provision-started.ts)
// enqueues one BullMQ job per tenant under `provisionJobId`; BullMQ keeps a failed job (`removeOnFail: false`),
// so this port is how platform ops see that a tenant is stuck in `provisioning` and re-run it (spec §7.7: "the
// tenant remains in `provisioning` until manual intervention").
import type { ProvisionJob } from "@wardenx/saas-tenant-platform";
import { addJobCoalescingInFlight } from "../../../bootstrap/queue-dedupe";
import { M34_QUEUES } from "./index";

export type ProvisionJobState = "queued" | "running" | "completed" | "failed" | "missing";

export interface ProvisionJobStatus {
  readonly state: ProvisionJobState;
  readonly attemptsMade: number;
  readonly failedReason: string | null;
}

export type ProvisionRetryResult = "retried" | "not_failed" | "missing";

export interface ProvisionJobPort {
  status(tenantAccountId: string): Promise<ProvisionJobStatus>;
  retry(tenantAccountId: string): Promise<ProvisionRetryResult>;
}

interface JobLike {
  getState(): Promise<string>;
  readonly attemptsMade: number;
  readonly failedReason?: string | undefined;
  retry(state?: "failed", opts?: { resetAttemptsMade?: boolean }): Promise<unknown>;
  remove(): Promise<unknown>;
}

export interface ProvisionQueueLike {
  getJob(jobId: string): Promise<JobLike | undefined | null>;
  add(
    name: string,
    data: unknown,
    opts: { jobId: string } & Record<string, unknown>,
  ): Promise<{ id?: string | undefined }>;
}

export const provisionJobId = (tenantAccountId: string): string =>
  `m34:${M34_QUEUES.provision}:${tenantAccountId}`;

const STATE_BY_BULLMQ: Readonly<Record<string, ProvisionJobState>> = {
  active: "running",
  completed: "completed",
  failed: "failed",
};

/** Anything BullMQ has not started (waiting, delayed, prioritized, waiting-children) is simply queued. */
const stateOf = (bullmqState: string): ProvisionJobState =>
  STATE_BY_BULLMQ[bullmqState] ?? "queued";

export function createProvisionJobPort(queue: ProvisionQueueLike): ProvisionJobPort {
  return {
    async status(tenantAccountId) {
      const job = await queue.getJob(provisionJobId(tenantAccountId));
      if (!job) return { state: "missing", attemptsMade: 0, failedReason: null };
      return {
        state: stateOf(await job.getState()),
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason ?? null,
      };
    },
    async retry(tenantAccountId) {
      const job = await queue.getJob(provisionJobId(tenantAccountId));
      if (!job) return "missing";
      if ((await job.getState()) !== "failed") return "not_failed";
      await job.retry("failed", { resetAttemptsMade: true });
      return "retried";
    },
  };
}

/** Enqueue the provision job; a finished job with the same id is cleared first so a re-delivery really runs. */
export function enqueueProvisionJob(
  queue: ProvisionQueueLike,
  tenantAccountId: string,
  payload: ProvisionJob,
): Promise<{ id?: string | undefined }> {
  return addJobCoalescingInFlight(queue, M34_QUEUES.provision, payload, {
    jobId: provisionJobId(tenantAccountId),
    attempts: 8,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: false,
  });
}
