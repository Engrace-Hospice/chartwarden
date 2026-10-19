import { escalationJobId } from "@wardenx/messaging";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createBullmqTimerPort, parseTimerJobData } from "./escalation-timers";
import { isFinalFailure, landInDlq, sweepTick, timerJobTick } from "./escalation-worker";

const ORG = "00000000-0000-4000-8000-00000000000a";
const REQUEST = "00000000-0000-4000-8000-0000000000f1";
const DEADLINE = new Date("2026-10-15T12:15:00.000Z");
const GOOD = {
  organizationId: ORG,
  requestId: REQUEST,
  tier: 0,
  deadlineAt: DEADLINE.toISOString(),
};

describe("parseTimerJobData", () => {
  it("accepts ids, a tier and an instant and normalises the instant", () => {
    expect(parseTimerJobData({ ...GOOD, deadlineAt: "2026-10-15T08:15:00-04:00" })).toEqual(GOOD);
  });

  it("rejects anything else as poison", () => {
    for (const bad of [
      null,
      "x",
      {},
      { ...GOOD, organizationId: "o" },
      { ...GOOD, requestId: 1 },
      { ...GOOD, tier: -1 },
      { ...GOOD, tier: 1.5 },
      { ...GOOD, deadlineAt: "never" },
    ]) {
      expect(parseTimerJobData(bad)).toBeNull();
    }
  });
});

describe("createBullmqTimerPort", () => {
  it("adds one delayed job under the deterministic id with ids only, bounded retries and no payload text", async () => {
    const add = vi.fn().mockResolvedValue({});
    const now = new Date(DEADLINE.getTime() - 5 * 60_000);

    await createBullmqTimerPort({ add }).arm(
      { orgId: ORG, requestId: REQUEST, tier: 0, deadlineAt: DEADLINE },
      now,
    );

    const [name, data, opts] = add.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(name).toBe("escalate");
    expect(data).toEqual(GOOD);
    expect(opts).toMatchObject({
      jobId: escalationJobId(REQUEST, 0, DEADLINE),
      delay: 5 * 60_000,
      attempts: 5,
      removeOnComplete: true,
    });
  });

  it("arms an already-due request with no delay", async () => {
    const add = vi.fn().mockResolvedValue({});

    await createBullmqTimerPort({ add }).arm(
      { orgId: ORG, requestId: REQUEST, tier: 1, deadlineAt: DEADLINE },
      new Date(DEADLINE.getTime() + 1_000),
    );

    expect((add.mock.calls[0] as unknown[])[2]).toMatchObject({ delay: 0 });
  });
});

describe("the worker bodies", () => {
  it("a poison payload is unrecoverable: no retry, never reaches the service", async () => {
    const processDue = vi.fn();

    await expect(
      timerJobTick({ service: { processDue, sweep: vi.fn() } }, { requestId: "x" }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(processDue).not.toHaveBeenCalled();
  });

  it("a good payload runs the guarded escalation for that exact window", async () => {
    const processDue = vi.fn().mockResolvedValue({ kind: "not_due" });

    await timerJobTick({ service: { processDue, sweep: vi.fn() } }, GOOD);

    expect(processDue).toHaveBeenCalledWith(ORG, REQUEST, { tier: 0, deadlineAt: DEADLINE });
  });

  it("the sweep tick fails when any request failed, so the failure is visible", async () => {
    const sweep = vi
      .fn()
      .mockResolvedValue({ flagOff: false, escalated: 0, notRouted: 0, skipped: 0, failed: 1 });
    const activeOrgs = { listActiveOrgs: async () => [{ organizationId: ORG }] };

    await expect(
      sweepTick({ service: { sweep, processDue: vi.fn() }, activeOrgs }),
    ).rejects.toThrow();
  });

  it("WP 4.9: observes every org after its sweep, and a failing observation is reported but never fails the tick", async () => {
    const sweep = vi.fn().mockResolvedValue({ escalated: 0, notRouted: 0, skipped: 0, failed: 0 });
    const observeOrg = vi.fn().mockRejectedValue(new Error("stats down"));
    const onError = vi.fn();
    const activeOrgs = { listActiveOrgs: async () => [{ organizationId: ORG }] };

    await sweepTick({ service: { sweep, processDue: vi.fn() }, activeOrgs, observeOrg, onError });

    expect(observeOrg).toHaveBeenCalledWith(ORG);
    expect(onError).toHaveBeenCalledWith(
      { organizationId: ORG, job: "ack_queue_observe" },
      expect.any(Error),
    );
    expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(
      observeOrg.mock.invocationCallOrder[0] as number,
    );
  });

  it("a dead timer job is copied to the DLQ queue and audited with a hashed payload, never verbatim", async () => {
    const add = vi.fn().mockResolvedValue({});
    const recordDlq = vi.fn().mockResolvedValue(undefined);

    await landInDlq(
      { recordDlq, now: () => new Date("2026-10-15T12:30:00.000Z") },
      { add },
      { id: "job-1", data: GOOD },
      new Error("boom"),
    );

    expect(add).toHaveBeenCalledWith("dead", GOOD, { jobId: "job-1-dlq", removeOnComplete: false });
    const [org, record, requestId] = recordDlq.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(org).toBe(ORG);
    expect(requestId).toBe(REQUEST);
    expect(record).toMatchObject({
      queue: "messaging.ack_escalation_timer",
      jobId: "job-1",
      disposition: "pending",
      finalError: "Error",
    });
    expect(JSON.stringify(record)).not.toContain(REQUEST);
  });

  it("a failed first landing is retried by the second report of the same death, then not repeated", async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error("redis blip")).mockResolvedValue({});
    const recordDlq = vi.fn().mockResolvedValue(undefined);
    const onDlqError = vi.fn();
    const deps = { recordDlq, onDlqError };
    const job = { id: "job-retry", data: GOOD };

    await landInDlq(deps, { add }, job, new Error("boom"));
    await landInDlq(deps, { add }, job, new Error("boom"));
    await landInDlq(deps, { add }, job, new Error("boom"));

    expect(onDlqError).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(2);
    expect(recordDlq).toHaveBeenCalledTimes(1);
  });

  it("reports (never swallows) a DLQ audit failure", async () => {
    const onDlqError = vi.fn();

    await landInDlq(
      {
        recordDlq: async () => {
          throw new Error("audit down");
        },
        onDlqError,
      },
      { add: vi.fn().mockResolvedValue({}) },
      { id: "job-2", data: GOOD },
      new Error("boom"),
    );

    expect(onDlqError).toHaveBeenCalledWith({ jobId: "job-2" }, expect.any(Error));
  });
});

describe("isFinalFailure", () => {
  const job = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 5 } });
  it("is final on the last attempt, on an unrecoverable error, and when BullMQ failed the job for stalling too often", () => {
    expect(isFinalFailure(job(4), new Error("boom"))).toBe(false);
    expect(isFinalFailure(job(5), new Error("boom"))).toBe(true);
    expect(isFinalFailure(job(1), new UnrecoverableError("poison"))).toBe(true);
    expect(isFinalFailure(job(0), new Error("job stalled more than allowable limit"))).toBe(true);
  });
});
