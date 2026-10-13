// A failed `tenant.provision` job used to be a dead end: the outbox consumer enqueued with a fixed jobId and
// `removeOnFail: false`, so a re-trigger was a silent BullMQ no-op, and nothing exposed the job's state or a retry.
// The provision job port reports the state and retries a FAILED job (never a queued/running/completed one);
// enqueueProvisionJob clears a finished job of the same id so a re-delivered provision_started really runs.
import { describe, expect, it, vi } from "vitest";
import {
  createProvisionJobPort,
  enqueueProvisionJob,
  provisionJobId,
} from "../jobs/provision-job-port";

function jobIn(state: string, extra: Record<string, unknown> = {}) {
  return {
    getState: vi.fn(async () => state),
    attemptsMade: 3,
    failedReason: undefined as string | undefined,
    retry: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...extra,
  };
}

const queueWith = (job: ReturnType<typeof jobIn> | undefined) => ({
  getJob: vi.fn(async () => job),
  add: vi.fn(async () => ({ id: "j" })),
});

describe("provisionJobId", () => {
  it("is stable per tenant so the consumer and the port address the same job", () => {
    expect(provisionJobId("t-1")).toBe(provisionJobId("t-1"));
    expect(provisionJobId("t-1")).not.toBe(provisionJobId("t-2"));
  });
});

describe("createProvisionJobPort.status", () => {
  it.each([
    ["waiting", "queued"],
    ["delayed", "queued"],
    ["active", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
  ])("maps BullMQ '%s' to '%s'", async (bull, expected) => {
    const port = createProvisionJobPort(queueWith(jobIn(bull)));

    expect((await port.status("t-1")).state).toBe(expected);
  });

  it("reports the failure reason and attempts of a failed job", async () => {
    const job = jobIn("failed", { failedReason: "gateway 503" });
    const port = createProvisionJobPort(queueWith(job));

    expect(await port.status("t-1")).toEqual({
      state: "failed",
      attemptsMade: 3,
      failedReason: "gateway 503",
    });
  });

  it("reports 'missing' when no job exists for the tenant", async () => {
    const port = createProvisionJobPort(queueWith(undefined));

    expect(await port.status("t-1")).toEqual({
      state: "missing",
      attemptsMade: 0,
      failedReason: null,
    });
  });
});

describe("createProvisionJobPort.retry", () => {
  it("retries a failed job", async () => {
    const job = jobIn("failed");
    const port = createProvisionJobPort(queueWith(job));

    expect(await port.retry("t-1")).toBe("retried");
    // Without resetAttemptsMade the exhausted attempt count survives, so the next failure ends the job at once.
    expect(job.retry).toHaveBeenCalledWith("failed", { resetAttemptsMade: true });
  });

  it.each(["waiting", "active", "completed"])("never retries a %s job", async (state) => {
    const job = jobIn(state);
    const port = createProvisionJobPort(queueWith(job));

    expect(await port.retry("t-1")).toBe("not_failed");
    expect(job.retry).not.toHaveBeenCalled();
  });

  it("says 'missing' when there is nothing to retry", async () => {
    const port = createProvisionJobPort(queueWith(undefined));

    expect(await port.retry("t-1")).toBe("missing");
  });
});

describe("enqueueProvisionJob", () => {
  const payload = { tenantAccountId: "t-1" } as never;

  it("removes a finished job with the same id before adding, so a re-trigger runs", async () => {
    const stale = jobIn("failed");
    const queue = queueWith(stale);

    await enqueueProvisionJob(queue, "t-1", payload);

    expect(stale.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      payload,
      expect.objectContaining({ jobId: provisionJobId("t-1"), removeOnFail: false }),
    );
  });

  it("leaves an in-flight job alone", async () => {
    const running = jobIn("active");
    const queue = queueWith(running);

    await enqueueProvisionJob(queue, "t-1", payload);

    expect(running.remove).not.toHaveBeenCalled();
  });
});
