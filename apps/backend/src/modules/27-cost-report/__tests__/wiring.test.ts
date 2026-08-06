// WX-PR-013 — unit suite for `buildM27RecomputeEnqueue`'s fail-closed default (no Valkey connection
// configured). The real BullMQ producer path (dedupe, organizationId enrichment) is proved against a real
// Redis in the live suite (m27-cost-report-workflow-slice.live.test.ts) — that path needs an actual
// `Queue.add` round trip, which this pure unit file intentionally does not stand up.
import { describe, expect, it } from "vitest";
import { M27InfraPortUnbound, buildM27RecomputeEnqueue } from "../wiring";

describe("buildM27RecomputeEnqueue — no Valkey connection configured", () => {
  it("fails closed with a typed M27InfraPortUnbound rather than silently dropping the enqueue", async () => {
    const { enqueue, queues } = buildM27RecomputeEnqueue(undefined);
    expect(queues).toEqual([]);
    await expect(
      enqueue.enqueue("allocation-recompute", "org-1:report-1:all", { costReportId: "report-1" }),
    ).rejects.toThrow(M27InfraPortUnbound);
    await expect(
      enqueue.enqueue("allocation-recompute", "org-1:report-1:all", { costReportId: "report-1" }),
    ).rejects.toThrow(/no Valkey connection configured/);
  });
});
