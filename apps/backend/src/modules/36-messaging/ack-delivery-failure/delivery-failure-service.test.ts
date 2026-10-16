// WP 4.5 - the delivery-failure service over the in-memory store: early escalation, failed_unreachable, idempotency, races.
import type { EscalationRouteAnswer } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createTierDecider } from "../ack-escalation/escalation-service";
import { createMemoryAckStore } from "../ack-requests/ack-store-memory";
import type { AckRow } from "../ack-requests/ack-types";
import { createDeliveryFailureService } from "./delivery-failure-service";

const ORG = "00000000-0000-4000-8000-00000000000a";
const REQUESTER = "00000000-0000-4000-8000-0000000000b1";
const ASSIGNEE = "00000000-0000-4000-8000-0000000000b2";
const TIER1 = "00000000-0000-4000-8000-0000000000c1";
const PATIENT = "00000000-0000-4000-8000-0000000000d1";
const CHANNEL = "00000000-0000-4000-8000-0000000000e1";
const MESSAGE = "00000000-0000-4000-8000-0000000000f2";
const T0 = new Date("2026-10-15T12:00:00.000Z");
const NOW = new Date(T0.getTime() + 2 * 60_000); // two minutes in: well before the 15-minute deadline

function seedRow(overrides: Partial<AckRow> = {}): AckRow {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    organizationId: ORG,
    messageId: MESSAGE,
    channelId: CHANNEL,
    patientId: PATIENT,
    ackClass: "urgent",
    status: "pending",
    requesterUserId: REQUESTER,
    assignedUserId: ASSIGNEE,
    requestedAt: T0,
    windowStartedAt: T0,
    deadlineAt: new Date(T0.getTime() + 15 * 60_000),
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

const resolved = (userIds: [string, ...string[]]) =>
  ({
    kind: "resolved",
    tier: 1,
    asOf: "",
    source: "m19",
    userIds,
    nextTier: null,
    timeZone: "UTC",
  }) as const;
const denyStub = {
  kind: "unavailable",
  reason: "router_not_bound",
  tier: 1,
  asOf: "",
  source: "deny_stub",
} as const;

function setup(
  opts: { answer?: EscalationRouteAnswer; enabled?: boolean; row?: Partial<AckRow> } = {},
) {
  const store = createMemoryAckStore();
  const row = seedRow(opts.row);
  store.requests.set(row.id, row);
  store.now = () => NOW;
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const service = createDeliveryFailureService({
    store,
    isEnabled: async () => opts.enabled ?? true,
    decide: createTierDecider({
      router: { resolveTier: async () => opts.answer ?? denyStub },
      stillQualified: async () => true,
    }),
    outbox: {
      async publish(_tx, e) {
        published.push({ eventName: e.eventName, payload: e.payload });
      },
    },
    now: () => NOW,
  });
  const facts = {
    messageId: MESSAGE,
    recipientUserId: ASSIGNEE,
    alertCreatedAt: new Date(T0.getTime() + 1000),
  };
  const stored = (): AckRow => store.requests.get(row.id) as AckRow;
  return { store, row, service, published, facts, stored };
}

describe("delivery-failure service", () => {
  it("does nothing when the tenant flag is off", async () => {
    const ctx = setup({ enabled: false });

    const outcome = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(outcome).toEqual({ kind: "flag_off" });
    expect(ctx.stored()).toEqual(ctx.row);
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.published).toHaveLength(0);
  });

  it("escalates to the next tier immediately, before the deadline", async () => {
    const ctx = setup({ answer: resolved([TIER1]) });

    const outcome = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(outcome).toMatchObject({ kind: "escalated", tier: 1, assignedUserId: TIER1 });
    expect(ctx.stored()).toMatchObject({
      status: "escalated",
      assignedUserId: TIER1,
      currentTier: 1,
    });
    expect(ctx.store.events.map((e) => e.eventType)).toEqual(["escalated", "delivery_failed"]);
    expect(ctx.published.map((p) => p.eventName)).toEqual(["m36.ack.escalated"]);
  });

  it("marks the request failed_unreachable when no tier can be reached (the deny-stub today)", async () => {
    const ctx = setup();

    const outcome = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(outcome).toMatchObject({ kind: "failed_unreachable" });
    expect(ctx.stored()).toMatchObject({
      status: "failed_unreachable",
      assignedUserId: ASSIGNEE,
      version: 1,
    });
    expect(ctx.store.events).toHaveLength(1);
    expect(ctx.store.events[0]).toMatchObject({
      eventType: "delivery_failed",
      actorUserId: null,
      fromStatus: "pending",
      toStatus: "failed_unreachable",
    });
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]?.eventName).toBe("m36.ack.failed_unreachable");
    expect(ctx.published[0]?.payload).toMatchObject({
      requestId: ctx.row.id,
      requestVersion: 1,
      actorUserId: null,
    });
  });

  it("publishes only ids, an enum, a version and an instant", async () => {
    const ctx = setup();

    await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(Object.keys(ctx.published[0]?.payload ?? {}).sort()).toEqual([
      "ackClass",
      "actorUserId",
      "assignedUserId",
      "at",
      "channelId",
      "messageId",
      "organizationId",
      "requestId",
      "requestVersion",
    ]);
  });

  it("is idempotent: a duplicate event after failed_unreachable writes nothing", async () => {
    const ctx = setup();
    await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    const again = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(again).toEqual({ kind: "not_waiting" });
    expect(ctx.store.events).toHaveLength(1);
    expect(ctx.published).toHaveLength(1);
  });

  it("two concurrent handlers produce exactly one write", async () => {
    const ctx = setup();

    const outcomes = await Promise.all([
      ctx.service.onAllRoutesFailed(ORG, ctx.facts),
      ctx.service.onAllRoutesFailed(ORG, ctx.facts),
    ]);

    expect(outcomes.filter((o) => o.kind === "failed_unreachable")).toHaveLength(1);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.stored().version).toBe(1);
  });

  it.each(["acknowledged", "resolved", "cancelled"] as const)(
    "never touches a %s request",
    async (status) => {
      const ctx = setup({ row: { status } });

      const outcome = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

      expect(outcome).toEqual({ kind: "not_waiting" });
      expect(ctx.stored().status).toBe(status);
      expect(ctx.published).toHaveLength(0);
    },
  );

  it("an acknowledgment that lands between the read and the write wins", async () => {
    const ctx = setup();
    const raceStore = ctx.store;
    const realRun = raceStore.runAsSystem.bind(raceStore);
    raceStore.runAsSystem = (async (orgId: string, fn: Parameters<typeof realRun>[1]) => {
      // The assignee acknowledges after the handler decided but before it wrote.
      ctx.store.requests.set(ctx.row.id, { ...ctx.stored(), status: "acknowledged", version: 1 });
      return realRun(orgId, fn);
    }) as typeof raceStore.runAsSystem;

    const outcome = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(outcome).toEqual({ kind: "stale" });
    expect(ctx.stored().status).toBe("acknowledged");
    expect(ctx.store.events).toHaveLength(0);
    expect(ctx.published).toHaveLength(0);
  });

  it("ignores a failure for someone who is no longer the assignee", async () => {
    const ctx = setup({ row: { assignedUserId: TIER1, currentTier: 1, status: "escalated" } });

    const outcome = await ctx.service.onAllRoutesFailed(ORG, ctx.facts);

    expect(outcome).toEqual({ kind: "not_current" });
    expect(ctx.published).toHaveLength(0);
  });

  it("ignores an alert from before the current window (a reassign restarted it)", async () => {
    const ctx = setup({ row: { windowStartedAt: new Date(T0.getTime() + 60_000) } });

    const outcome = await ctx.service.onAllRoutesFailed(ORG, {
      ...ctx.facts,
      alertCreatedAt: new Date(T0.getTime() + 30_000),
    });

    expect(outcome).toEqual({ kind: "not_current" });
  });

  it("allows a few seconds of skew: an alert created just before the window start is still current, a minute before is not", async () => {
    const start = new Date(T0.getTime() + 60_000);
    const skewed = setup({ row: { windowStartedAt: start } });
    const stale = setup({ row: { windowStartedAt: start } });

    const near = await skewed.service.onAllRoutesFailed(ORG, {
      ...skewed.facts,
      alertCreatedAt: new Date(start.getTime() - 3_000),
    });
    const far = await stale.service.onAllRoutesFailed(ORG, {
      ...stale.facts,
      alertCreatedAt: new Date(start.getTime() - 60_000),
    });

    expect(near.kind).toBe("failed_unreachable");
    expect(far).toEqual({ kind: "not_current" });
  });

  it("ignores an unknown message", async () => {
    const ctx = setup();

    const outcome = await ctx.service.onAllRoutesFailed(ORG, {
      ...ctx.facts,
      messageId: "00000000-0000-4000-8000-00000000ffff",
    });

    expect(outcome).toEqual({ kind: "not_waiting" });
  });

  it("a router error propagates (the outbox retries) and writes nothing", async () => {
    const ctx = setup();
    const failing = createDeliveryFailureService({
      store: ctx.store,
      isEnabled: async () => true,
      decide: async () => {
        throw new Error("router down");
      },
      outbox: undefined,
      now: () => NOW,
    });

    await expect(failing.onAllRoutesFailed(ORG, ctx.facts)).rejects.toThrow("router down");
    expect(ctx.stored()).toEqual(ctx.row);
  });
});
