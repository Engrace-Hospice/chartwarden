// ADR-0079 (G-5) - the unreachable watch: a bounded, backed-off schedule once the deadline has passed, once per stage fleet-wide, flag-gated,
// writes nothing to the request.
import { UNROUTED_MAX_RECORDS, unroutedBackoffMs } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import { createOpsNoticeClaims } from "../../../bootstrap/ops-notice-claims";
import { createMemoryAckStore } from "../ack-requests/ack-store-memory";
import type { AckRow } from "../ack-requests/ack-types";
import {
  UNWATCHED_TOTAL_MS,
  UNWATCHED_WINDOWS_MS,
  createUnreachableWatch,
  unwatchedStage,
} from "./unreachable-watch";

const ORG = "00000000-0000-4000-8000-00000000000a";
const HOUR = 60 * 60_000;
const T0 = new Date("2026-10-15T12:00:00.000Z");
const MIN = 60_000;

describe("unwatchedStage", () => {
  it("opens at the deadline and follows the unroutable backoff: 0, 1 h, 3 h, 7 h ...", () => {
    expect(unwatchedStage(-1)).toBeNull();
    expect(unwatchedStage(0)).toEqual({ stage: 0, windowMs: HOUR });
    expect(unwatchedStage(HOUR - 1)?.stage).toBe(0);
    expect(unwatchedStage(HOUR)).toEqual({ stage: 1, windowMs: 2 * HOUR });
    expect(unwatchedStage(3 * HOUR)?.stage).toBe(2);
    expect(unwatchedStage(7 * HOUR)?.stage).toBe(3);
  });

  it("pins ALL eight windows and openings from the code: 1, 2, 4, 8, 16, 24, 24, 24 h; open at 0, 1, 3, 7, 15, 31, 55, 79 h; ends at 103 h", () => {
    expect(UNWATCHED_WINDOWS_MS.map((ms) => ms / HOUR)).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
    const opens = UNWATCHED_WINDOWS_MS.map((_, i) =>
      UNWATCHED_WINDOWS_MS.slice(0, i).reduce((a, b) => a + b, 0),
    );
    expect(opens.map((ms) => ms / HOUR)).toEqual([0, 1, 3, 7, 15, 31, 55, 79]);
    opens.forEach((ms, i) => expect(unwatchedStage(ms)?.stage).toBe(i));
    expect(UNWATCHED_TOTAL_MS / HOUR).toBe(103);
    expect(unwatchedStage(UNWATCHED_TOTAL_MS - 1)?.stage).toBe(7);
    expect(unwatchedStage(UNWATCHED_TOTAL_MS)).toBeNull();
  });

  it("skipFirst (the request failed after its deadline: the failure alert just fired) drops stage 0 only", () => {
    expect(unwatchedStage(0, true)).toBeNull();
    expect(unwatchedStage(HOUR - 1, true)).toBeNull();
    expect(unwatchedStage(HOUR, true)?.stage).toBe(1);
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
  async function setup(
    over: { enabled?: boolean; status?: AckRow["status"]; now?: Date; failedAt?: Date } = {},
  ) {
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
          updatedAt: over.failedAt ?? T0,
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
      claims,
      newWatch: (c = claims) =>
        createUnreachableWatch({
          store,
          isEnabled: async () => true,
          claims: c,
          attention: { alerts: { emit } as never, opsNotice },
          now: () => now,
        }),
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

  it("M1: a crash after the notice claim must not lose the stage - the alert is re-emitted on the next tick, and the notice is NOT repeated", async () => {
    const ctx = await setup();
    ctx.emit.mockRejectedValueOnce(new Error("blip"));

    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 0, failed: 1 });
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 0, failed: 0 });
    expect(ctx.emit).toHaveBeenCalledTimes(2);
    expect(ctx.opsNotice).toHaveBeenCalledOnce();
  });

  it("M4: an alert that keeps failing re-tries every tick but sends the webhook notice once per stage, not every minute", async () => {
    const ctx = await setup();
    ctx.emit.mockRejectedValue(new Error("down"));

    for (let i = 0; i < 5; i += 1) {
      expect((await ctx.watch.watch(ORG)).failed).toBe(1);
      ctx.advance(MIN);
    }
    expect(ctx.emit).toHaveBeenCalledTimes(5);
    expect(ctx.opsNotice).toHaveBeenCalledOnce();
  });

  it("a second worker (fresh process, shared claims) finishes a stage the first one claimed but never emitted, without a second notice", async () => {
    const ctx = await setup();
    ctx.emit.mockRejectedValueOnce(new Error("crash"));
    await ctx.watch.watch(ORG);
    const other = ctx.newWatch(); // same claims, empty emitted memory
    expect(await other.watch(ORG)).toEqual({ raised: 1, failed: 0 });
    expect(ctx.opsNotice).toHaveBeenCalledOnce();
  });

  it("the unpaged notice is claimed under its own key: a re-emit that plans no page does not repeat it", async () => {
    const ctx = await setup();
    ctx.emit.mockResolvedValue({ alertId: "a", resolvedRecipientCount: 2, outOfBandPlanned: 0 });
    await ctx.watch.watch(ORG);
    await ctx.newWatch().watch(ORG); // another process re-emits the same stage
    const unpaged = ctx.opsNotice.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "m36.ack.supervisor_unpaged",
    );
    expect(unpaged).toHaveLength(1);
  });

  it("M2: more exhausted rows than the batch never starve a fresh one, which is still raised; exhausted rows cost no alert", async () => {
    const store = createMemoryAckStore();
    const add = async (n: number, deadline: Date) =>
      store.runAsSystem(ORG, async (tx) => {
        const { row } = await tx.insert({
          organizationId: ORG,
          messageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
          channelId: "00000000-0000-4000-8000-0000000000e1",
          patientId: "00000000-0000-4000-8000-0000000000d1",
          ackClass: "urgent",
          requesterUserId: "00000000-0000-4000-8000-0000000000b1",
          assignedUserId: "00000000-0000-4000-8000-0000000000b2",
          requestedAt: T0,
          windowStartedAt: T0,
          deadlineAt: deadline,
        } as never);
        await tx.update(row.id, row.version, { status: "failed_unreachable", updatedAt: deadline });
        return row.id;
      });
    const now = new Date(T0.getTime() + 300 * HOUR);
    for (let i = 1; i <= 505; i += 1) await add(i, new Date(T0.getTime() + i * 1000)); // all exhausted (>103 h past)
    const fresh = await add(9999, new Date(now.getTime() - 10 * 60_000));
    const emit = vi.fn(async (_o: string, _i: Record<string, unknown>) => ({
      alertId: "a",
      resolvedRecipientCount: 1,
      outOfBandPlanned: 1,
    }));
    const set = vi.fn(async () => "OK" as const);
    const watch = createUnreachableWatch({
      store,
      isEnabled: async () => true,
      claims: createOpsNoticeClaims({ set, del: async () => 1 }, () => now.getTime()),
      attention: { alerts: { emit } as never, opsNotice: vi.fn() },
      now: () => now,
    });

    expect(await watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
    expect((emit.mock.calls[0]?.[1] as { payload: { requestId: string } }).payload.requestId).toBe(
      fresh,
    );
    expect(set).toHaveBeenCalledTimes(1); // one Valkey call: rows with no stage cost none
  });

  it("a throwing ops sink cannot lose the stage: the alert still goes, the error is reported, the stage completes", async () => {
    const errors: unknown[] = [];
    const ctx = await setup();
    ctx.opsNotice.mockImplementation(() => {
      throw new Error("sink down");
    });
    const watch = createUnreachableWatch({
      store: ctx.store,
      isEnabled: async () => true,
      claims: ctx.claims,
      attention: { alerts: { emit: ctx.emit } as never, opsNotice: ctx.opsNotice },
      now: () => new Date(T0.getTime() + 16 * 60_000),
      onError: (_c, e) => errors.push(e),
    });
    expect(await watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
    expect(ctx.emit).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });

  it("a request that fails BEFORE its deadline anchors on the deadline: stage 0 fires at the deadline", async () => {
    const ctx = await setup({ failedAt: new Date(T0.getTime() + 5 * MIN) }); // deadline is T0+15 min
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 1, failed: 0 }); // now = T0+16 min
    expect(ctx.emit).toHaveBeenCalledOnce();
  });

  it("M3: a request that fails 5 h after its deadline is paged once (the failure alert), not twice: nothing at the failure, stage 1 an hour later", async () => {
    const failedAt = new Date(T0.getTime() + 15 * 60_000 + 5 * HOUR);
    const ctx = await setup({ failedAt, now: failedAt });
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 0, failed: 0 });
    expect(ctx.emit).not.toHaveBeenCalled();
    ctx.advance(HOUR);
    expect(await ctx.watch.watch(ORG)).toEqual({ raised: 1, failed: 0 });
  });

  it("never changes the request", async () => {
    const ctx = await setup();
    await ctx.watch.watch(ORG);
    const after = await ctx.store.readAsSystem(ORG, (tx) => tx.findById(ctx.row.id, false));
    expect(after?.status).toBe("failed_unreachable");
  });
});
