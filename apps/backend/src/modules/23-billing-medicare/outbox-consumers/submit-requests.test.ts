import { describe, expect, it } from "vitest";
import { buildM23SubmissionRequestConsumer } from "./submit-requests";

describe("M23 submission outbox bridge", () => {
  it("enriches a claim job with its trusted outbox organization and deduplicates by submission", async () => {
    const calls: unknown[] = [];
    const consumer = buildM23SubmissionRequestConsumer({
      async enqueue(...args) {
        calls.push(args);
      },
    });
    await consumer.handle({
      id: "event-1",
      organizationId: "org-1",
      eventType: "m23.claim.submit_requested",
      aggregateKind: "claim",
      aggregateId: "claim-1",
      payload: {
        claimId: "claim-1",
        submissionId: "submission-1",
        claimControlNumber: "control-1",
        attemptIndex: 0,
      },
      attemptCount: 1,
      createdAt: new Date(),
    });
    expect(calls).toEqual([
      [
        "claim.submit",
        "submission-1",
        {
          organizationId: "org-1",
          claimId: "claim-1",
          submissionId: "submission-1",
          claimControlNumber: "control-1",
          attemptIndex: 0,
        },
      ],
    ]);
  });

  it("maps a persisted failure to a retry job without requiring transient transport data", async () => {
    const calls: unknown[] = [];
    const consumer = buildM23SubmissionRequestConsumer({
      async enqueue(...args) {
        calls.push(args);
      },
    });
    await consumer.handle({
      id: "event-2",
      organizationId: "org-1",
      eventType: "m23.claim.submission_failed",
      aggregateKind: "claim",
      aggregateId: "claim-1",
      payload: {
        claimId: "claim-1",
        submissionId: "submission-1",
        attemptIndex: 0,
        reason: "gateway unavailable",
      },
      attemptCount: 1,
      createdAt: new Date(),
    });
    expect(calls).toEqual([
      [
        "claim.submit.retry",
        "submission-1:0",
        {
          organizationId: "org-1",
          claimId: "claim-1",
          submissionId: "submission-1",
          attemptIndex: 0,
        },
      ],
    ]);
  });
});
