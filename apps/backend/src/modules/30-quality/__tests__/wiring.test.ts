// WX-PR-014 — unit suite for `buildM30RecomputeEnqueue`'s fail-closed default (no Valkey connection
// configured). The real BullMQ producer path (dedupe, the ':' → '__' jobId sanitization this task fixed —
// BullMQ rejects a custom jobId containing ':', which M30's own colon-delimited dedupe keys collided with)
// is proved against a real Redis in the live suite (m30-quality-scheduled-jobs.live.test.ts) — that path
// needs an actual `Queue.add` round trip, which this pure unit file intentionally does not stand up.
import { DegradedError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { M30InfraPortUnbound, buildM30RecomputeEnqueue } from "../wiring";

describe("buildM30RecomputeEnqueue — no Valkey connection configured", () => {
  it("fails closed with a typed M30InfraPortUnbound rather than silently dropping the enqueue", async () => {
    const { enqueue, queues } = buildM30RecomputeEnqueue(undefined);
    expect(queues).toEqual([]);
    await expect(
      enqueue.enqueue("m30.measure_recompute", "org-1:hci_indicator_01", {
        measureId: "hci_indicator_01",
      }),
    ).rejects.toThrow(M30InfraPortUnbound);
    await expect(
      enqueue.enqueue("m30.measure_recompute", "org-1:hci_indicator_01", {
        measureId: "hci_indicator_01",
      }),
    ).rejects.toThrow(/no Valkey connection configured/);
  });

  // F-022 (#55) — the caller-facing half. This used to be a bare `Error`, so a deliberately unbound
  // port arrived as `500 INTERNAL_ERROR / "An unexpected error occurred"` while the sentence naming
  // the missing dependency sat in the log under "unhandled error". It is a DegradedError now: the
  // dependency-unavailable condition it always was, and the posture M34's equivalent already took.
  it("is a DegradedError, so an unbound port answers 503 naming the dependency, not a bare 500", async () => {
    const { enqueue } = buildM30RecomputeEnqueue(undefined);
    const err = (await enqueue
      .enqueue("m30.measure_recompute", "org-1:hci_indicator_01", {
        measureId: "hci_indicator_01",
      })
      .catch((e: unknown) => e)) as DegradedError & { port: string };
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("DEGRADED");
    // What the CALLER is told: which dependency is missing, and what could not be done with it.
    expect(err.message).toMatch(/background-queue/);
    expect(err.message).toMatch(/no Valkey connection configured/);
    expect(err.message).toMatch(/m30\.measure_recompute/);
    // The internal port name is NOT in the message — it stays on `port`, for the log.
    expect(err.message).not.toContain("recomputeEnqueue");
    expect(err.port).toBe("recomputeEnqueue");
  });
});
