// F-022 (#55) — unit suite for `buildM33ReadEnqueue`'s fail-closed default (no Valkey connection
// configured). The M27 / M30 siblings already had one; M33's producer had none, so its class could be
// changed with nothing to notice. The real BullMQ producer path is proved against a real Redis in
// m33-scheduled-jobs.live.test.ts — that needs an actual `Queue.add` round trip, which this pure unit
// file intentionally does not stand up.
import { DegradedError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { M33InfraPortUnbound, buildM33ReadEnqueue } from "../wiring";

describe("buildM33ReadEnqueue — no Valkey connection configured", () => {
  it("fails closed with a typed M33InfraPortUnbound rather than silently dropping the enqueue", async () => {
    const { enqueue, queues } = buildM33ReadEnqueue(undefined);
    expect(queues).toEqual([]);
    await expect(
      enqueue.enqueue("report.mv_refresh", "org-1:mv_census", { view: "mv_census" }),
    ).rejects.toThrow(M33InfraPortUnbound);
  });

  // The caller-facing half. This used to be a bare `Error`, so a deliberately unbound port arrived as
  // `500 INTERNAL_ERROR / "An unexpected error occurred"` while the sentence naming the missing
  // dependency sat in the log under "unhandled error". It is a DegradedError now: the
  // dependency-unavailable condition it always was, and the posture M34's equivalent already took.
  it("is a DegradedError, so an unbound port answers 503 naming the dependency, not a bare 500", async () => {
    const { enqueue } = buildM33ReadEnqueue(undefined);
    const err = (await enqueue
      .enqueue("report.mv_refresh", "org-1:mv_census", { view: "mv_census" })
      .catch((e: unknown) => e)) as DegradedError & { port: string };
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("DEGRADED");
    expect(err.message).toMatch(/background-queue/);
    expect(err.message).toMatch(/no Valkey connection configured/);
    expect(err.message).toMatch(/report\.mv_refresh/);
    // The internal port name is NOT in the message — it stays on `port`, for the log.
    expect(err.message).not.toContain("readEnqueue");
    expect(err.port).toBe("readEnqueue");
  });
});
