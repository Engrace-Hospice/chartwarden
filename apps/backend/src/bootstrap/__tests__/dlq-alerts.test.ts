// TASK-040D (OPS-012) — the DLQ-promotion alert helper. Tested with a plain EventEmitter standing in
// for a BullMQ `Worker` (WorkerLike is deliberately minimal for exactly this) — no Redis needed.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  type FailedJobLike,
  attachDlqPromotionAlert,
  buildDlqPromotionSink,
  formatDlqPromotion,
} from "../dlq-alerts";

function fakeWorker() {
  const emitter = new EventEmitter();
  return {
    worker: {
      on: (event: "failed", listener: (job: FailedJobLike | undefined, err: Error) => void) =>
        emitter.on(event, listener),
    },
    fail: (job: FailedJobLike | undefined, err: Error) => emitter.emit("failed", job, err),
  };
}

describe("attachDlqPromotionAlert", () => {
  it("fires onDlqPromotion when attemptsMade reaches the configured attempts (the final try)", () => {
    const { worker, fail } = fakeWorker();
    const onDlqPromotion = vi.fn();
    attachDlqPromotionAlert(worker, "m7.gates", onDlqPromotion);

    fail({ id: "job-1", attemptsMade: 3, opts: { attempts: 3 } }, new Error("boom"));

    expect(onDlqPromotion).toHaveBeenCalledTimes(1);
    expect(onDlqPromotion).toHaveBeenCalledWith(
      expect.objectContaining({ source: "m7.gates", jobId: "job-1", attempts: 3, error: "boom" }),
    );
  });

  it("does NOT fire when the job will still retry (attemptsMade below the configured attempts)", () => {
    const { worker, fail } = fakeWorker();
    const onDlqPromotion = vi.fn();
    attachDlqPromotionAlert(worker, "m7.gates", onDlqPromotion);

    fail({ id: "job-1", attemptsMade: 1, opts: { attempts: 3 } }, new Error("transient"));

    expect(onDlqPromotion).not.toHaveBeenCalled();
  });

  it("extracts organizationId from job.data when present, omits it otherwise", () => {
    const { worker, fail } = fakeWorker();
    const onDlqPromotion = vi.fn();
    attachDlqPromotionAlert(worker, "outbox", onDlqPromotion);

    fail(
      { id: "job-2", attemptsMade: 1, opts: { attempts: 1 }, data: { organizationId: "org-a" } },
      new Error("db down"),
    );
    fail({ id: "job-3", attemptsMade: 1, opts: { attempts: 1 } }, new Error("no data at all"));

    expect(onDlqPromotion).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ jobId: "job-2", organizationId: "org-a" }),
    );
    expect(onDlqPromotion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ jobId: "job-3", organizationId: undefined }),
    );
  });

  it("defaults a missing opts.attempts to 1 (a job with no retry config dead-letters on its first failure)", () => {
    const { worker, fail } = fakeWorker();
    const onDlqPromotion = vi.fn();
    attachDlqPromotionAlert(worker, "m9.license", onDlqPromotion);

    fail({ id: "job-4" }, new Error("first and only try"));

    expect(onDlqPromotion).toHaveBeenCalledTimes(1);
  });

  it("ignores a 'failed' event with no job (BullMQ emits this for some connection-level errors)", () => {
    const { worker, fail } = fakeWorker();
    const onDlqPromotion = vi.fn();
    attachDlqPromotionAlert(worker, "m10.windows", onDlqPromotion);

    fail(undefined, new Error("connection reset"));

    expect(onDlqPromotion).not.toHaveBeenCalled();
  });
});

describe("the promotion log line", () => {
  const base = {
    source: "m23:claimmd-webhook-receipt",
    error: "boom",
    occurredAt: "2026-08-04T00:00:00Z",
  };

  it("is exactly what it always was for a promotion that has an attempt count", () => {
    expect(formatDlqPromotion({ ...base, jobId: "usage:e1", attempts: 5 })).toBe(
      "🚨 DLQ promotion [m23:claimmd-webhook-receipt] job=usage:e1 after 5 attempt(s): boom",
    );
    expect(formatDlqPromotion({ ...base, organizationId: "org-1", jobId: "j", attempts: 0 })).toBe(
      "🚨 DLQ promotion [m23:claimmd-webhook-receipt] org=org-1 job=j after 0 attempt(s): boom",
    );
    expect(formatDlqPromotion({ ...base, attempts: 3 })).toBe(
      "🚨 DLQ promotion [m23:claimmd-webhook-receipt] after 3 attempt(s): boom",
    );
  });

  it("omits the attempts clause when there is no count, instead of saying `after ? attempt(s)`", () => {
    const line = formatDlqPromotion({ ...base, error: "2 receipt(s) went terminal failed" });
    expect(line).toBe(
      "🚨 DLQ promotion [m23:claimmd-webhook-receipt]: 2 receipt(s) went terminal failed",
    );
    expect(line).not.toMatch(/\?|attempt/);
    expect(formatDlqPromotion({ ...base, jobId: "j" })).toBe(
      "🚨 DLQ promotion [m23:claimmd-webhook-receipt] job=j: boom",
    );
  });

  it("the sink logs that line", () => {
    const log = vi.fn();
    buildDlqPromotionSink({ log })({ ...base });
    expect(log).toHaveBeenCalledWith("🚨 DLQ promotion [m23:claimmd-webhook-receipt]: boom");
  });
});

describe("buildDlqPromotionSink", () => {
  it("always logs a structured line naming the source, attempts, and error", () => {
    const log = vi.fn();
    const sink = buildDlqPromotionSink({ log });
    sink({
      source: "m7.gates",
      jobId: "j1",
      attempts: 3,
      error: "boom",
      occurredAt: "2026-08-04T00:00:00Z",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("m7.gates");
    expect(log.mock.calls[0]![0]).toContain("boom");
    expect(log.mock.calls[0]![0]).toContain("3");
  });

  it("POSTs to the webhook when configured, without throwing on delivery failure", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const sink = buildDlqPromotionSink({ webhookUrl: "https://ops.example/alert", fetchImpl, log });

    sink({ source: "outbox", error: "dead-lettered", occurredAt: "2026-08-04T00:00:00Z" });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget rejection settle

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ops.example/alert",
      expect.objectContaining({ method: "POST" }),
    );
    expect(log).toHaveBeenCalledTimes(2); // the structured line + the delivery-failure warning
    expect(log.mock.calls[1]![0]).toContain("webhook delivery failed");
  });

  it("never calls fetch when no webhookUrl is configured (log-only default)", () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    const sink = buildDlqPromotionSink({ fetchImpl, log });
    sink({ source: "m25.denial_aging_scan", error: "boom", occurredAt: "2026-08-04T00:00:00Z" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
