// WX-PR-014 — unit suite for `buildM30RecomputeEnqueue`'s fail-closed default (no Valkey connection
// configured). The real BullMQ producer path (dedupe, the ':' → '__' jobId sanitization this task fixed —
// BullMQ rejects a custom jobId containing ':', which M30's own colon-delimited dedupe keys collided with)
// is proved against a real Redis in the live suite (m30-quality-scheduled-jobs.live.test.ts) — that path
// needs an actual `Queue.add` round trip, which this pure unit file intentionally does not stand up.
import { describe, expect, it } from "vitest";
import { M30InfraPortUnbound, buildM30RecomputeEnqueue } from "../wiring";

describe("buildM30RecomputeEnqueue — no Valkey connection configured", () => {
  it("fails closed with a typed M30InfraPortUnbound rather than silently dropping the enqueue", async () => {
    const { enqueue, queues } = buildM30RecomputeEnqueue(undefined);
    expect(queues).toEqual([]);
    await expect(
      enqueue.enqueue("m30.measure_recompute", "org-1:hci_indicator_01", { measureId: "hci_indicator_01" }),
    ).rejects.toThrow(M30InfraPortUnbound);
    await expect(
      enqueue.enqueue("m30.measure_recompute", "org-1:hci_indicator_01", { measureId: "hci_indicator_01" }),
    ).rejects.toThrow(/no Valkey connection configured/);
  });
});
