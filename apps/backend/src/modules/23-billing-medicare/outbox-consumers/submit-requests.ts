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
  "m23.transfer_notice.submit_requested",
  "m23.claim.submission_failed",
] as const;

/**
 * GAP-070: the two request events that had no bridge, so `validation-run` / `eligibility.refresh` jobs could
 * never be created from a committed request. Separate from the submission set because these queues need only a
 * queue connection (their workers do no X12/MAC-portal I/O), while the submission queues need the launch gateway.
 */
export const M23_WORK_REQUEST_EVENTS = [
  "m23.claim.validation_started",
  "m23.eligibility.refresh_requested",
] as const;

type M23QueueName =
  | "claim.submit"
  | "claim.submit.retry"
  | "noe.submit"
  | "notr.submit"
  | "transfer_notice.submit"
  | "validation-run"
  | "eligibility.refresh";

/**
 * The re-validation trigger the `revalidate.consumer` worker stamps on its own runs. That worker enqueues the
 * `validation-run` job DIRECTLY, and the claim-validation service then re-announces the run with
 * `m23.claim.validation_started` (for reporting). The bridge must not turn that echo back into another job —
 * it would loop forever — so it only bridges requests that came from the route (any other trigger).
 */
const REVALIDATE_CONSUMER_TRIGGER = "re_validation_after_correction";

export interface M23SubmissionQueuePort {
  enqueue(queueName: M23QueueName, jobId: string, payload: Record<string, unknown>): Promise<void>;
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
  queue: M23QueueName;
  key: string;
  payload: Record<string, unknown>;
} | null {
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
  if (event.eventType === "m23.transfer_notice.submit_requested") {
    const transferNoticeId = requiredString(event.payload.transferNoticeId, "transferNoticeId");
    const submissionId = requiredString(event.payload.submissionId, "submissionId");
    return {
      queue: "transfer_notice.submit",
      key: submissionId,
      payload: { transferNoticeId, submissionId },
    };
  }
  if (event.eventType === "m23.claim.validation_started") {
    const trigger = requiredString(event.payload.trigger, "trigger");
    // The worker's own echo (see REVALIDATE_CONSUMER_TRIGGER): settled, not a request.
    if (trigger === REVALIDATE_CONSUMER_TRIGGER) return null;
    const claimId = requiredString(event.payload.claimId, "claimId");
    const validationRunId = requiredString(event.payload.validationRunId, "validationRunId");
    return {
      queue: "validation-run",
      key: validationRunId,
      payload: { claimId, validationRunId, trigger },
    };
  }
  if (event.eventType === "m23.eligibility.refresh_requested") {
    const patientId = requiredString(event.payload.patientId, "patientId");
    const providerEntityId = requiredString(event.payload.providerEntityId, "providerEntityId");
    const asOfServiceDate = requiredString(event.payload.asOfServiceDate, "asOfServiceDate");
    return {
      queue: "eligibility.refresh",
      key: `${patientId}:${asOfServiceDate}:${event.id}`,
      payload: { patientId, providerEntityId, asOfServiceDate },
    };
  }
  throw new Error(`unsupported M23 submission event '${event.eventType}'`);
}

function bridgeConsumer(
  consumerName: string,
  eventTypes: readonly string[],
  queue: M23SubmissionQueuePort,
): OutboxConsumerBinding {
  return {
    consumerName,
    consumerModule: "m23",
    eventTypes,
    async handle(event) {
      const request = queueRequest(event);
      if (request === null) return;
      await queue.enqueue(request.queue, request.key, {
        organizationId: event.organizationId,
        ...request.payload,
      });
    },
  };
}

/** Durable outbox → BullMQ handoff. The queue job id makes a relay retry idempotent. */
export function buildM23SubmissionRequestConsumer(
  queue: M23SubmissionQueuePort,
): OutboxConsumerBinding {
  return bridgeConsumer("m23.submission-request-enqueue", M23_SUBMISSION_REQUEST_EVENTS, queue);
}

/** Durable outbox → BullMQ handoff for the `validation-run` and `eligibility.refresh` work queues. */
export function buildM23WorkRequestConsumer(queue: M23SubmissionQueuePort): OutboxConsumerBinding {
  return bridgeConsumer("m23.work-request-enqueue", M23_WORK_REQUEST_EVENTS, queue);
}

/** The request-thread queue names the outbox bridge can serve. */
const GATED_QUEUES: ReadonlySet<string> = new Set(["validation-run", "eligibility.refresh"]);

/**
 * Request-thread gate: proves the durable consumer and worker capability exist without touching Redis.
 *
 * `enabled` says whether the outbox bridge + a worker for that queue are really running. The route writes the
 * request event in the same transaction and the bridge turns the COMMITTED event into the job (so a rolled-back
 * request never leaves a job behind); a queue whose capability is off is refused with 503 rather than accepted
 * and never completed.
 */
export function buildM23OutboxBackedSubmissionGate(
  enabled: boolean | { readonly [queue: string]: boolean },
): JobEnqueuePort {
  const isEnabled = (queueName: string): boolean =>
    typeof enabled === "boolean" ? enabled : enabled[queueName] === true;
  return {
    async enqueue(queueName, dedupeKey) {
      const known =
        GATED_QUEUES.has(queueName) ||
        [...M23_SUBMISSION_REQUEST_EVENTS].some((event) => event.includes(queueName));
      if (!known || !isEnabled(queueName)) {
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
