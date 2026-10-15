// WP 4.4 - the escalation service over the in-memory store: the algorithm, the race outcomes, the fail-closed deny path.
import type { EscalationRouteAnswer, EscalationRouter } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createMemoryAckStore } from "../ack-requests/ack-store-memory";
import type { AckRow } from "../ack-requests/ack-types";
import { createEscalationService } from "./escalation-service";

const ORG = "00000000-0000-4000-8000-00000000000a";
const REQUESTER = "00000000-0000-4000-8000-0000000000b1";
const ASSIGNEE = "00000000-0000-4000-8000-0000000000b2";
const TIER1_A = "00000000-0000-4000-8000-0000000000c1";
const TIER1_B = "00000000-0000-4000-8000-0000000000c2";
const TIER2 = "00000000-0000-4000-8000-0000000000c3";
const PATIENT = "00000000-0000-4000-8000-0000000000d1";
const CHANNEL = "00000000-0000-4000-8000-0000000000e1";
const T0 = new Date("2026-10-15T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;

function seedRow(overrides: Partial<AckRow> = {}): AckRow {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    organizationId: ORG,
    messageId: "00000000-0000-4000-8000-0000000000f2",
    channelId: CHANNEL,
    patientId: PATIENT,
    ackClass: "urgent",
    status: "pending",
    requesterUserId: REQUESTER,
    assignedUserId: ASSIGNEE,
    requestedAt: T0,
    windowStartedAt: T0,
    deadlineAt: new Date(T0.getTime() + minutes(15)),
    currentTier: 0,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    cancelledAt: null,
    version: 0,
    ...overrides,
  };
}

const resolved = (tier: number, userIds: [string, ...string[]], nextTier: number | null) =>
  ({
    kind: "resolved",
    tier,
    asOf: "",
    source: "m19",
    userIds,
    nextTier,
    timeZone: "UTC",
  }) as const;
const gap = (tier: number, nextTier: number | null) =>
  ({ kind: "coverage_gap", tier, asOf: "", source: "m19", nextTier, timeZone: "UTC" }) as const;
const unavailable = (reason: "router_not_bound" | "tier_not_configured") =>
  ({ kind: "unavailable", reason, tier: 1, asOf: "", source: "deny_stub" }) as const;

interface SetupOptions {
  readonly answers?: Record<number, EscalationRouteAnswer>;
  readonly router?: EscalationRouter;
  readonly enabled?: boolean;
  readonly qualified?: (userId: string) => boolean;
  readonly row?: Partial<AckRow>;
}

function setup(opts: SetupOptions = {}) {
  const store = createMemoryAckStore();
  const row = seedRow(opts.row);
  store.requests.set(row.id, row);
  const clock = { now: new Date(T0.getTime() + minutes(16)) };
  store.now = () => clock.now;
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const asked: Array<{ tier: number; asOf: string; requiredRole: string; patientId: string }> = [];
  const router: EscalationRouter = opts.router ?? {
    async resolveTier(_org, req) {
      asked.push(req);
      return opts.answers?.[req.tier] ?? unavailable("router_not_bound");
    },
  };
  const service = createEscalationService({
    store,
    isEnabled: async () => opts.enabled ?? true,
    router,
    stillQualified: async (_o, userId) => (opts.qualified ? opts.qualified(userId) : true),
    outbox: {
      async publish(_tx, e) {
        published.push({ eventName: e.eventName, payload: e.payload });
      },
    },
    now: () => clock.now,
  });
  return { store, row, clock, service, published, asked };
}

const stored = (ctx: ReturnType<typeof setup>): AckRow =>
  ctx.store.requests.get(ctx.row.id) as AckRow;

describe("escalation service", () => {
  it("leaves a due request untouched when the flag is off", async () => {
    const ctx = setup({ enabled: false });

    const outcome = await ctx.service.processDue(ORG, ctx.row.id);

    expect(outcome).toEqual({ kind: "flag_off" });
    expect(stored(ctx)).toEqual(ctx.row);
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.published).toHaveLength(0);
  });

  it("does nothing before the deadline", async () => {
    const ctx = setup();
    ctx.clock.now = new Date(ctx.row.deadlineAt.getTime() - 1);

    expect(await ctx.service.processDue(ORG, ctx.row.id)).toEqual({ kind: "not_due" });
    expect(ctx.store.events).toHaveLength(0);
  });

  it("escalates a pending request to the next tier's qualified user, once, with its history row and event", async () => {
    const ctx = setup({ answers: { 1: resolved(1, [TIER1_A], 2) } });

    const outcome = await ctx.service.processDue(ORG, ctx.row.id);

    expect(outcome).toMatchObject({ kind: "escalated", tier: 1, assignedUserId: TIER1_A });
    const after = stored(ctx);
    expect(after).toMatchObject({
      status: "escalated",
      assignedUserId: TIER1_A,
      currentTier: 1,
      version: 1,
    });
    // The urgent class gets 7 minutes at tier 1, counted from the database's now().
    expect(after.deadlineAt.getTime()).toBe(after.windowStartedAt.getTime() + minutes(7));
    expect(ctx.store.events).toEqual([
      expect.objectContaining({
        eventType: "escalated",
        actorUserId: null,
        fromStatus: "pending",
        toStatus: "escalated",
        assignedUserId: TIER1_A,
        previousAssignedUserId: ASSIGNEE,
        tier: 1,
      }),
    ]);
    expect(ctx.published.map((p) => p.eventName)).toEqual(["m36.ack.escalated"]);
    expect(ctx.published[0]?.payload).toMatchObject({
      requestId: ctx.row.id,
      assignedUserId: TIER1_A,
      previousAssignedUserId: ASSIGNEE,
      tier: 1,
      requestVersion: 1,
      actorUserId: null,
    });
    // The router is asked with the request's own patient and an instant with an explicit Z.
    expect(ctx.asked).toEqual([
      expect.objectContaining({
        tier: 1,
        patientId: PATIENT,
        asOf: "2026-10-15T12:16:00.000Z",
        requiredRole: "rn",
      }),
    ]);
  });

  it("a duplicate delivery after the escalation does nothing (no second incident)", async () => {
    const ctx = setup({ answers: { 1: resolved(1, [TIER1_A], 2) } });

    await ctx.service.processDue(ORG, ctx.row.id);
    const again = await ctx.service.processDue(ORG, ctx.row.id, {
      tier: 0,
      deadlineAt: ctx.row.deadlineAt,
    });

    expect(again).toEqual({ kind: "not_due" });
    expect(ctx.store.events).toHaveLength(1);
    expect(ctx.published).toHaveLength(1);
  });

  it("two concurrent executions of the same due request produce exactly one escalation", async () => {
    const ctx = setup({ answers: { 1: resolved(1, [TIER1_A], 2) } });

    const outcomes = await Promise.all([
      ctx.service.processDue(ORG, ctx.row.id),
      ctx.service.processDue(ORG, ctx.row.id),
    ]);

    expect(outcomes.filter((o) => o.kind === "escalated")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "stale")).toHaveLength(1);
    expect(ctx.store.events).toHaveLength(1);
    expect(ctx.published).toHaveLength(1);
  });

  it("a job armed for an old window does nothing after a reassign moved the deadline", async () => {
    const ctx = setup({ answers: { 1: resolved(1, [TIER1_A], 2) } });
    ctx.store.requests.set(ctx.row.id, {
      ...ctx.row,
      assignedUserId: TIER1_B,
      windowStartedAt: new Date(T0.getTime() + minutes(14)),
      deadlineAt: new Date(T0.getTime() + minutes(29)),
      version: 1,
    });
    // The clock is past the NEW deadline too, so only the window check can stop the old job.
    ctx.clock.now = new Date(T0.getTime() + minutes(40));

    const outcome = await ctx.service.processDue(ORG, ctx.row.id, {
      tier: 0,
      deadlineAt: ctx.row.deadlineAt,
    });

    expect(outcome).toEqual({ kind: "not_due" });
    expect(ctx.store.events).toHaveLength(0);
  });

  it("an acknowledgment that lands while the router is being asked wins: nothing escalates", async () => {
    const holder: { ctx?: ReturnType<typeof setup> } = {};
    const router: EscalationRouter = {
      async resolveTier(_org, req) {
        const ctx = holder.ctx as ReturnType<typeof setup>;
        ctx.store.requests.set(ctx.row.id, { ...stored(ctx), status: "acknowledged", version: 1 });
        return resolved(req.tier, [TIER1_A], 2);
      },
    };
    holder.ctx = setup({ router });
    const ctx = holder.ctx;

    const outcome = await ctx.service.processDue(ORG, ctx.row.id);

    expect(outcome).toEqual({ kind: "stale" });
    expect(stored(ctx).status).toBe("acknowledged");
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.published).toHaveLength(0);
  });

  it("an escalation that lands first leaves a late acknowledgment to the new assignee (the other order)", async () => {
    const ctx = setup({ answers: { 1: resolved(1, [TIER1_A], 2) } });

    await ctx.service.processDue(ORG, ctx.row.id);

    const after = stored(ctx);
    expect(after.status).toBe("escalated");
    // The escalated request is still open and its new assignee is the one who may now acknowledge it.
    expect(after.assignedUserId).toBe(TIER1_A);
  });

  it("an acknowledged, resolved, cancelled or failed_unreachable request is never due", async () => {
    for (const status of ["acknowledged", "resolved", "cancelled", "failed_unreachable"] as const) {
      const ctx = setup({ row: { status } });
      expect(await ctx.service.processDue(ORG, ctx.row.id)).toEqual({ kind: "not_due" });
      expect(ctx.store.events).toHaveLength(0);
    }
  });

  describe("when no tier can be reached (the deny-stub is today's production behaviour)", () => {
    it("keeps the request open, records one route_unavailable row and event, and invents no recipient", async () => {
      const ctx = setup();

      const outcome = await ctx.service.processDue(ORG, ctx.row.id);

      expect(outcome).toEqual({ kind: "not_routed", reason: "route_unavailable", recorded: true });
      expect(stored(ctx)).toEqual(ctx.row);
      expect(ctx.store.events).toEqual([
        expect.objectContaining({
          eventType: "route_unavailable",
          actorUserId: null,
          fromStatus: "pending",
          toStatus: "pending",
          assignedUserId: ASSIGNEE,
          tier: 1,
        }),
      ]);
      expect(ctx.published.map((p) => p.eventName)).toEqual(["m36.ack.route_unavailable"]);
    });

    it("asks again on every sweep but records and alerts at most once per hour", async () => {
      const ctx = setup();

      await ctx.service.processDue(ORG, ctx.row.id);
      ctx.clock.now = new Date(ctx.clock.now.getTime() + minutes(30));
      const second = await ctx.service.processDue(ORG, ctx.row.id);
      ctx.clock.now = new Date(ctx.clock.now.getTime() + minutes(31));
      const third = await ctx.service.processDue(ORG, ctx.row.id);

      expect(second).toEqual({ kind: "not_routed", reason: "route_unavailable", recorded: false });
      expect(third).toMatchObject({ recorded: true });
      expect(ctx.store.events).toHaveLength(2);
      expect(ctx.published).toHaveLength(2);
    });

    it("escalates on the first attempt after a router is bound", async () => {
      const answers: Record<number, EscalationRouteAnswer> = {};
      const ctx = setup({ answers });

      await ctx.service.processDue(ORG, ctx.row.id);
      answers[1] = resolved(1, [TIER1_A], null);
      const outcome = await ctx.service.processDue(ORG, ctx.row.id);

      expect(outcome).toMatchObject({ kind: "escalated", assignedUserId: TIER1_A });
      expect(stored(ctx).status).toBe("escalated");
    });

    it("says ladder_exhausted when the router has no such tier", async () => {
      const ctx = setup({ answers: { 1: unavailable("tier_not_configured") } });

      const outcome = await ctx.service.processDue(ORG, ctx.row.id);

      expect(outcome).toEqual({ kind: "not_routed", reason: "ladder_exhausted", recorded: true });
      expect(ctx.store.events[0]?.eventType).toBe("ladder_exhausted");
      expect(ctx.published[0]?.eventName).toBe("m36.ack.ladder_exhausted");
      expect(stored(ctx).status).toBe("pending");
    });

    it("is not routed when the tier exists but nobody on it is usable (the sender, the assignee, an unqualified user)", async () => {
      const ctx = setup({
        answers: { 1: resolved(1, [REQUESTER, ASSIGNEE, TIER1_B], null) },
        qualified: (userId) => userId !== TIER1_B,
      });

      const outcome = await ctx.service.processDue(ORG, ctx.row.id);

      expect(outcome).toMatchObject({ kind: "not_routed", reason: "route_unavailable" });
      expect(stored(ctx).assignedUserId).toBe(ASSIGNEE);
    });
  });

  it("skips a tier nobody covers to the router's next tier", async () => {
    const ctx = setup({ answers: { 1: gap(1, 2), 2: resolved(2, [TIER2], null) } });

    const outcome = await ctx.service.processDue(ORG, ctx.row.id);

    expect(outcome).toMatchObject({ kind: "escalated", tier: 2, assignedUserId: TIER2 });
    expect(stored(ctx).currentTier).toBe(2);
  });

  it("takes the first qualified user of the tier, never the sender or the assignee who did not act", async () => {
    const ctx = setup({
      answers: { 1: resolved(1, [REQUESTER, ASSIGNEE, TIER1_A, TIER1_B], null) },
    });

    const outcome = await ctx.service.processDue(ORG, ctx.row.id);

    expect(outcome).toMatchObject({ kind: "escalated", assignedUserId: TIER1_A });
  });

  it("goes up another tier when an escalated request is again unanswered", async () => {
    const ctx = setup({ answers: { 1: resolved(1, [TIER1_A], 2), 2: resolved(2, [TIER2], null) } });

    await ctx.service.processDue(ORG, ctx.row.id);
    const afterFirst = stored(ctx);
    ctx.clock.now = new Date(afterFirst.deadlineAt.getTime() + 1);
    const outcome = await ctx.service.processDue(ORG, ctx.row.id, {
      tier: 1,
      deadlineAt: afterFirst.deadlineAt,
    });

    expect(outcome).toMatchObject({ kind: "escalated", tier: 2, assignedUserId: TIER2 });
    expect(ctx.store.events.map((e) => [e.eventType, e.tier])).toEqual([
      ["escalated", 1],
      ["escalated", 2],
    ]);
  });

  it("lets a router failure propagate and writes nothing", async () => {
    const ctx = setup({
      router: {
        async resolveTier() {
          throw new Error("m19 down");
        },
      },
    });

    await expect(ctx.service.processDue(ORG, ctx.row.id)).rejects.toThrow("m19 down");
    expect(ctx.store.events).toHaveLength(0);
    expect(stored(ctx)).toEqual(ctx.row);
  });

  it("lets a qualification lookup failure propagate and writes nothing", async () => {
    const base = setup();
    const service = createEscalationService({
      store: base.store,
      isEnabled: async () => true,
      router: { resolveTier: async (_o, r) => resolved(r.tier, [TIER1_A], null) },
      stillQualified: async () => {
        throw new Error("lookup failed");
      },
      outbox: undefined,
      now: () => base.clock.now,
    });

    await expect(service.processDue(ORG, base.row.id)).rejects.toThrow("lookup failed");
    expect(base.store.events).toHaveLength(0);
  });

  describe("sweep", () => {
    it("does nothing while the flag is off", async () => {
      const ctx = setup({ enabled: false });

      expect(await ctx.service.sweep(ORG)).toEqual({
        flagOff: true,
        escalated: 0,
        notRouted: 0,
        skipped: 0,
        failed: 0,
      });
      expect(ctx.store.events).toHaveLength(0);
    });

    it("handles every due request, oldest deadline first, and isolates a failing one", async () => {
      const ctx = setup();
      const older = seedRow({
        id: "00000000-0000-4000-8000-0000000000f9",
        messageId: "00000000-0000-4000-8000-0000000000fa",
        deadlineAt: new Date(T0.getTime() + minutes(10)),
      });
      const notYetDue = seedRow({
        id: "00000000-0000-4000-8000-0000000000fb",
        messageId: "00000000-0000-4000-8000-0000000000fc",
        deadlineAt: new Date(T0.getTime() + minutes(60)),
      });
      ctx.store.requests.set(older.id, older);
      ctx.store.requests.set(notYetDue.id, notYetDue);
      const errors: string[] = [];
      let calls = 0;
      const sweeping = createEscalationService({
        store: ctx.store,
        isEnabled: async () => true,
        router: {
          async resolveTier(_o, r) {
            calls += 1;
            if (calls === 1) throw new Error("boom");
            return resolved(r.tier, [TIER1_A], null);
          },
        },
        stillQualified: async () => true,
        outbox: undefined,
        now: () => ctx.clock.now,
        onError: (c) => errors.push(c.requestId),
      });

      const summary = await sweeping.sweep(ORG);

      expect(errors).toEqual([older.id]);
      expect(summary).toEqual({
        flagOff: false,
        escalated: 1,
        notRouted: 0,
        skipped: 0,
        failed: 1,
      });
      expect(stored(ctx).status).toBe("escalated");
      expect((ctx.store.requests.get(notYetDue.id) as AckRow).status).toBe("pending");
    });
  });
});
