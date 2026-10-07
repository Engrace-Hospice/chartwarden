import { describe, expect, it } from "vitest";
import {
  buildM23OutboxBackedSubmissionGate,
  buildM23SubmissionRequestConsumer,
  buildM23WorkRequestConsumer,
} from "./submit-requests";

const eventBase = {
  organizationId: "org-1",
  aggregateKind: "claim",
  aggregateId: "claim-1",
  attemptCount: 1,
  createdAt: new Date(),
};

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

  it("bridges a transfer-notice submit request onto the transfer_notice.submit queue", async () => {
    const calls: unknown[] = [];
    const consumer = buildM23SubmissionRequestConsumer({
      async enqueue(...args) {
        calls.push(args);
      },
    });
    await consumer.handle({
      ...eventBase,
      id: "event-tn",
      eventType: "m23.transfer_notice.submit_requested",
      aggregateKind: "transfer_notice_record",
      aggregateId: "tn-1",
      payload: { transferNoticeId: "tn-1", submissionId: "sub-tn", controlNumber: "c" },
    });
    expect(calls).toEqual([
      [
        "transfer_notice.submit",
        "sub-tn",
        { organizationId: "org-1", transferNoticeId: "tn-1", submissionId: "sub-tn" },
      ],
    ]);
  });

  it("gates transfer_notice.submit on its own capability flag", async () => {
    const off = buildM23OutboxBackedSubmissionGate({ "transfer_notice.submit": false });
    await expect(off.enqueue("transfer_notice.submit", "k", {})).rejects.toMatchObject({
      statusCode: 503,
    });
    const on = buildM23OutboxBackedSubmissionGate({ "transfer_notice.submit": true });
    await expect(on.enqueue("transfer_notice.submit", "k", {})).resolves.toEqual({
      jobId: "outbox:k",
    });
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

describe("M23 work-request outbox bridge (GAP-070)", () => {
  const capture = () => {
    const calls: unknown[] = [];
    return {
      calls,
      port: {
        async enqueue(...args: unknown[]) {
          calls.push(args);
        },
      },
    };
  };

  it("turns a committed route validation request into a validation-run job keyed by its run id", async () => {
    const { calls, port } = capture();
    await buildM23WorkRequestConsumer(port as never).handle({
      ...eventBase,
      id: "event-3",
      eventType: "m23.claim.validation_started",
      payload: { claimId: "claim-1", validationRunId: "run-1", trigger: "manual_re_run" },
    });
    expect(calls).toEqual([
      [
        "validation-run",
        "run-1",
        {
          organizationId: "org-1",
          claimId: "claim-1",
          validationRunId: "run-1",
          trigger: "manual_re_run",
        },
      ],
    ]);
  });

  it("does not echo the revalidate worker's own validation_started back into a job (no loop)", async () => {
    const { calls, port } = capture();
    await buildM23WorkRequestConsumer(port as never).handle({
      ...eventBase,
      id: "event-4",
      eventType: "m23.claim.validation_started",
      payload: {
        claimId: "claim-1",
        validationRunId: "run-2",
        trigger: "re_validation_after_correction",
      },
    });
    expect(calls).toEqual([]);
  });

  it("turns an eligibility refresh request into an eligibility.refresh job carrying the provider entity", async () => {
    const { calls, port } = capture();
    await buildM23WorkRequestConsumer(port as never).handle({
      ...eventBase,
      id: "event-5",
      eventType: "m23.eligibility.refresh_requested",
      payload: { patientId: "p-1", providerEntityId: "pe-1", asOfServiceDate: "2026-10-05" },
    });
    expect(calls).toEqual([
      [
        "eligibility.refresh",
        "p-1:2026-10-05:event-5",
        {
          organizationId: "org-1",
          patientId: "p-1",
          providerEntityId: "pe-1",
          asOfServiceDate: "2026-10-05",
        },
      ],
    ]);
  });

  it("rejects a refresh request that lacks the provider entity (never fabricates one)", async () => {
    const { port } = capture();
    await expect(
      buildM23WorkRequestConsumer(port as never).handle({
        ...eventBase,
        id: "event-6",
        eventType: "m23.eligibility.refresh_requested",
        payload: { patientId: "p-1", asOfServiceDate: "2026-10-05" },
      }),
    ).rejects.toThrow(/providerEntityId/);
  });
});

describe("M23 outbox-backed submission gate", () => {
  it("accepts validation-run when its capability is on and refuses eligibility.refresh while HETS is unbound", async () => {
    const gate = buildM23OutboxBackedSubmissionGate({
      "claim.submit": false,
      "validation-run": true,
      "eligibility.refresh": false,
    });
    await expect(gate.enqueue("validation-run", "k1", {})).resolves.toEqual({
      jobId: "outbox:k1",
    });
    await expect(gate.enqueue("eligibility.refresh", "k2", {})).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(gate.enqueue("claim.submit", "k3", {})).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("keeps the boolean form working for the submission queues", async () => {
    const gate = buildM23OutboxBackedSubmissionGate(true);
    await expect(gate.enqueue("noe.submit", "k", {})).resolves.toEqual({ jobId: "outbox:k" });
  });
});
