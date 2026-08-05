import type { ProvisionJob } from "@wardenx/saas-tenant-platform";
import { type ConnectionOptions, Queue } from "bullmq";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M34_QUEUES } from "../jobs";

export interface M34ProvisionQueuePort {
  enqueue(jobId: string, payload: ProvisionJob): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function provisionJob(value: unknown): ProvisionJob {
  if (!record(value)) throw new Error("m34.tenant.provision_started payload must be an object");
  const keys = [
    "tenantAccountId",
    "organizationId",
    "legalBusinessName",
    "billingContactEmail",
    "firstAdminEmail",
    "firstAdminFullName",
    "actorMembershipId",
    "transitionReason",
  ] as const;
  for (const key of keys) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`m34.tenant.provision_started has invalid '${key}'`);
    }
  }
  return value as unknown as ProvisionJob;
}

export function buildM34ProvisionStartedConsumer(
  queue: M34ProvisionQueuePort,
): OutboxConsumerBinding {
  return {
    consumerName: "m34.tenant-provision-enqueue",
    consumerModule: "m34",
    eventTypes: ["m34.tenant.provision_started"],
    async handle(event: DispatchableOutboxEvent) {
      await queue.enqueue(event.aggregateId, provisionJob(event.payload));
    },
  };
}

export function buildM34ProvisionQueue(connection: ConnectionOptions): {
  readonly port: M34ProvisionQueuePort;
  readonly close: () => Promise<void>;
} {
  const queue = new Queue(M34_QUEUES.provision, { connection });
  return {
    port: {
      async enqueue(jobId, payload) {
        await queue.add(M34_QUEUES.provision, payload, {
          jobId: `m34:${M34_QUEUES.provision}:${jobId}`,
          attempts: 8,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        });
      },
    },
    close: () => queue.close(),
  };
}
