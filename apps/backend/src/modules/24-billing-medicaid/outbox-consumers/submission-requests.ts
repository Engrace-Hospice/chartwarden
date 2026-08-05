// apps/backend/src/modules/24-billing-medicaid/outbox-consumers/submission-requests.ts — WX-PR-011: the
// durable outbox → BullMQ handoff for `m24.medicaid_claim.submit_requested`, mirroring M23's
// `outbox-consumers/submit-requests.ts` file-for-file. The route (write-service-drizzle.ts's `submitClaim`)
// already persists the `pending` submission row + this event transactionally; this consumer's ONLY job is
// to hand the durable event to BullMQ (`M24_QUEUES.submit`) so `runClaimSubmit` (jobs/submission-jobs.ts)
// picks it up. A relay retry is idempotent — the BullMQ jobId is derived from the submissionId.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M24_QUEUES } from "../jobs/queues";

export const M24_SUBMISSION_REQUEST_EVENTS = ["m24.medicaid_claim.submit_requested"] as const;

export interface M24SubmissionQueuePort {
  enqueue(
    queueName: "medicaid-claim.submit" | "medicaid-claim.poll",
    jobId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`M24 submission request has invalid '${field}'`);
  }
  return value;
};

export function buildM24SubmissionRequestConsumer(
  queue: M24SubmissionQueuePort,
): OutboxConsumerBinding {
  return {
    consumerName: "m24.submission-request-enqueue",
    consumerModule: "m24",
    eventTypes: M24_SUBMISSION_REQUEST_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      if (!record(event.payload))
        throw new Error("M24 submission request payload must be an object");
      const claimId = requiredString(event.payload.claimId, "claimId");
      const submissionId = requiredString(event.payload.submissionId, "submissionId");
      await queue.enqueue(M24_QUEUES.submit, submissionId, {
        organizationId: event.organizationId,
        claimId,
        submissionId,
      });
    },
  };
}
