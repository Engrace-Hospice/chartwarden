import { WardenXError } from "@wardenx/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { JobEnqueuePort } from "../routes/write-service";

export const M23_SUBMISSION_REQUEST_EVENTS = [
  "m23.claim.submit_requested",
  "m23.noe.submit_requested",
  "m23.notr.submit_requested",
  "m23.claim.submission_failed",
] as const;

export interface M23SubmissionQueuePort {
  enqueue(
    queueName: "claim.submit" | "claim.submit.retry" | "noe.submit" | "notr.submit",
    jobId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`M23 submission request has invalid '${field}'`);
  }
  return value;
};

function queueRequest(event: DispatchableOutboxEvent): {
  queue: "claim.submit" | "claim.submit.retry" | "noe.submit" | "notr.submit";
  key: string;
  payload: Record<string, unknown>;
} {
  if (!record(event.payload)) throw new Error("M23 submission request payload must be an object");
  if (event.eventType === "m23.claim.submit_requested") {
    const claimId = requiredString(event.payload.claimId, "claimId");
    const submissionId = requiredString(event.payload.submissionId, "submissionId");
    const claimControlNumber = requiredString(
      event.payload.claimControlNumber,
      "claimControlNumber",
    );
    const attemptIndex = event.payload.attemptIndex;
    if (!Number.isInteger(attemptIndex) || (attemptIndex as number) < 0) {
      throw new Error("M23 submission request has invalid 'attemptIndex'");
    }
    return {
      queue: "claim.submit",
      key: submissionId,
      payload: { claimId, submissionId, claimControlNumber, attemptIndex },
    };
  }
  if (event.eventType === "m23.claim.submission_failed") {
    const claimId = requiredString(event.payload.claimId, "claimId");
    const submissionId = requiredString(event.payload.submissionId, "submissionId");
    const attemptIndex = event.payload.attemptIndex;
    if (!Number.isInteger(attemptIndex) || (attemptIndex as number) < 0) {
      throw new Error("M23 submission failure has invalid 'attemptIndex'");
    }
    return {
      queue: "claim.submit.retry",
      key: `${submissionId}:${attemptIndex}`,
      payload: { claimId, submissionId, attemptIndex },
    };
  }
  if (event.eventType === "m23.noe.submit_requested") {
    const noeId = requiredString(event.payload.noeId, "noeId");
    const submissionId = requiredString(event.payload.submissionId, "submissionId");
    return { queue: "noe.submit", key: submissionId, payload: { noeId } };
  }
  if (event.eventType === "m23.notr.submit_requested") {
    const notrId = requiredString(event.payload.notrId, "notrId");
    const submissionId = requiredString(event.payload.submissionId, "submissionId");
    return { queue: "notr.submit", key: submissionId, payload: { notrId } };
  }
  throw new Error(`unsupported M23 submission event '${event.eventType}'`);
}

/** Durable outbox → BullMQ handoff. The queue job id makes a relay retry idempotent. */
export function buildM23SubmissionRequestConsumer(
  queue: M23SubmissionQueuePort,
): OutboxConsumerBinding {
  return {
    consumerName: "m23.submission-request-enqueue",
    consumerModule: "m23",
    eventTypes: M23_SUBMISSION_REQUEST_EVENTS,
    async handle(event) {
      const request = queueRequest(event);
      await queue.enqueue(request.queue, request.key, {
        organizationId: event.organizationId,
        ...request.payload,
      });
    },
  };
}

/** Request-thread gate: proves the durable consumer and worker capability exist without touching Redis. */
export function buildM23OutboxBackedSubmissionGate(enabled: boolean): JobEnqueuePort {
  return {
    async enqueue(queueName, dedupeKey) {
      if (!enabled || !M23_SUBMISSION_REQUEST_EVENTS.some((event) => event.includes(queueName))) {
        throw new WardenXError(
          "SEAM_UNBOUND",
          `billing worker capability '${queueName}' is not available`,
          503,
        );
      }
      return { jobId: `outbox:${dedupeKey}` };
    },
  };
}
