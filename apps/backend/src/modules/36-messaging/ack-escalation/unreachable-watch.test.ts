// ADR-0079 (G-5) - the unreachable watch: a bounded, backed-off schedule once the deadline has passed, once per stage fleet-wide, flag-gated,
// writes nothing to the request.
import { UNROUTED_MAX_RECORDS, unroutedBackoffMs } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import { createOpsNoticeClaims } from "../../../bootstrap/ops-notice-claims";
import { createMemoryAckStore } from "../ack-requests/ack-store-memory";
import type { AckRow } from "../ack-requests/ack-types";
import { createUnreachableWatch, unwatchedStage } from "./unreachable-watch";

const ORG = "00000000-0000-4000-8000-00000000000a";
const HOUR = 60 * 60_000;
const T0 = new Date("2026-10-15T12:00:00.000Z");

describe("unwatchedStage", () => {
  it("opens at the deadline and follows the unroutable backoff: 0, 1 h, 3 h, 7 h ...", () => {
    expect(unwatchedStage(-1)).toBeNull();
    expect(unwatchedStage(0)).toEqual({ stage: 0, windowMs: HOUR });
    expect(unwatchedStage(HOUR - 1)?.stage).toBe(0);
    expect(unwatchedStage(HOUR)).toEqual({ stage: 1, windowMs: 2 * HOUR });
    expect(unwatchedStage(3 * HOUR)?.stage).toBe(2);
    expect(unwatchedStage(7 * HOUR)?.stage).toBe(3);
  });

  it("is bounded: exactly UNROUTED_MAX_RECORDS stages, then nothing more is raised", () => {
    let total = 0;
    for (let k = 1; k <= UNROUTED_MAX_RECORDS; k += 1) total += unroutedBackoffMs(k);
    expect(unwatchedStage(total - 1)?.stage).toBe(UNROUTED_MAX_RECORDS - 1);
    expect(unwatchedStage(total)).toBeNull();
    expect(unwatchedStage(365 * 24 * HOUR)).toBeNull();
  });
});

describe("createUnreachableWatch", () => {
  async function setup(over: { enabled?: boolean; status?: AckRow["status"]; now?: Date } = {}) {
    const store = createMemoryAckStore();
    const row = await store.runAsSystem(
      ORG,
      async (tx) =>
        (
          await tx.insert({
            organizationId: ORG,
            messageId: "00000000-0000-4000-8000-0000000000f2",
            channelId: "00000000-0000-4000-8000-0000000000e1",
            patientId: "00000000-0000-4000-8000-0000000000d1",
            ackClass: "urgent",
            requesterUserId: "00000000-0000-4000-8000-0000000000b1",
            assignedUserId: "00000000-0000-4000-8000-0000000000b2",
            requestedAt: T0,
            windowStartedAt: T0,
            deadlineAt: new Date(T0.getTime() + 15 * 60_000),
          } as never)
        ).row,
    );
    if ((over.status ?? "failed_unreachable") !== "pending") {
      await store.runAsSystem(ORG, (tx) =>
        tx.update(row.id, row.version, {
          status: over.status ?? "failed_unreachable",
          updatedAt: T0,
        }),
      );
    }
    let now = over.now ?? new Date(T0.getTime() + 16 * 60_000);
    const emit = vi.fn(async (_orgId: string, _input: Record<string, unknown>) => ({
      alertId: "a",
      resolvedRecipientCount: 2,
      outOfBandPlanned: 1,
    }));
    const opsNotice = vi.fn();
    const claims = createOpsNoticeClaims(undefined, () => now.getTime());
    const watch = createUnreachableWatch({
      store,
      isEnabled: async () => over.enabled ?? true,
      claims,
      attention: { alerts: { emit } as never, opsNotice },
      now: () => now,
    });
    return {
      watch,
      emit,
      opsNotice,
      store,
      row,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  it("raises the notice and the supervisor alert once for a request past its deadline, not again on the next tick", async () => {
    const ctx = await setup();

    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 0, failed: 0 });

    expect(ctx.opsNotice).toHaveBeenCalledOnce();
    expect(ctx.opsNotice.mock.calls[0]?.[0]).toMatchObject({
      kind: "m36.ack.failed_unreachable_unwatched",
      details: { organizationId: ORG, requestId: ctx.row.id, ackClass: "urgent", reminder: 1 },
    });
    expect(ctx.emit).toHaveBeenCalledOnce();
    expect(ctx.emit.mock.calls[0]?.[1]).toMatchObject({
      eventType: "m36.ack.supervisor_attention",
      payload: { reason: "unwatched", ackClass: "urgent" },
    });
  });

  it("raises the next reminder when the next stage opens, with a new alert id", async () => {
    const ctx = await setup();
    await ctx.watch.watch(ORG);
    ctx.advance(HOUR);
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
    const ids = ctx.emit.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(2);
  });

  it("does nothing before the deadline, for a request that is not failed_unreachable, or with the flag off", async () => {
    expect((await (await setup({ now: T0 })).watch.watch(ORG)).raised).toBe(0);
    expect((await (await setup({ status: "pending" })).watch.watch(ORG)).raised).toBe(0);
    const off = await setup({ enabled: false });
    expect((await off.watch.watch(ORG)).raised).toBe(0);
    expect(off.emit).not.toHaveBeenCalled();
  });

  it("releases the claim when the alert fails, so the next tick retries, and counts the failure", async () => {
    const ctx = await setup();
    ctx.emit.mockRejectedValueOnce(new Error("blip"));

    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 0, failed: 1 });
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
  });

  it("never changes the request", async () => {
    const ctx = await setup();
    await ctx.watch.watch(ORG);
    const after = await ctx.store.readAsSystem(ORG, (tx) => tx.findById(ctx.row.id, false));
    expect(after?.status).toBe("failed_unreachable");
  });
});
