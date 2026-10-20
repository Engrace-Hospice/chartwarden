import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import type { AckRow } from "../ack-requests/ack-types";
import {
  ACK_ESCALATION_NOTIFICATION_TEXT,
  M36_ACK_ESCALATION_NOTIFICATION_CONSUMER,
  buildM36AckEscalationNotificationsConsumer,
} from "./ack-escalation-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQUESTER = "u-1";
const TIER_USER = "u-3";
const T = "2026-10-15T12:16:00.000Z";

const row = (over: Partial<AckRow> = {}): AckRow =>
  ({
    id: "r-1",
    ackClass: "urgent",
    status: "escalated",
    requesterUserId: REQUESTER,
    assignedUserId: TIER_USER,
    version: 1,
    ...over,
  }) as AckRow;

const event = (eventType: string, payload: Record<string, unknown> = {}) =>
  ({
    id: "evt-1",
    eventType,
    organizationId: ORG,
    payload: {
      organizationId: "attacker-copy-is-ignored",
      requestId: "r-1",
      messageId: "m-1",
      channelId: "ch-1",
      ackClass: "urgent",
      assignedUserId: TIER_USER,
      actorUserId: null,
      requestVersion: 1,
      at: T,
      ...payload,
    },
  }) as never;

function setup(
  over: {
    request?: AckRow | null;
    canView?: (userId: string) => Promise<boolean>;
    qualified?: () => Promise<boolean>;
    /** Out-of-band deliveries the (fake) emitter reports as planned for the supervisor alert. */
    planned?: number;
  } = {},
) {
  const warn = vi.fn();
  const emit = vi.fn().mockResolvedValue({
    alertId: "a",
    resolvedRecipientCount: 1,
    outOfBandPlanned: over.planned ?? 1,
  });
  const opsNotice = vi.fn();
  const consumer = buildM36AckEscalationNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    opsNotice,
    messaging: {
      canViewChannel: async (_o, userId) => (over.canView ?? (async () => true))(userId),
    },
    readRequest: async () => (over.request === undefined ? row() : over.request),
    stillQualified: over.qualified ?? (async () => true),
    warn,
  });
  return { emit, warn, consumer, opsNotice };
}

describe("M36 ack escalation notifications consumer", () => {
  it("subscribes to the three escalation events under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_ACK_ESCALATION_NOTIFICATION_CONSUMER);
    expect(consumer.eventTypes).toEqual([
      "m36.ack.escalated",
      "m36.ack.route_unavailable",
      "m36.ack.ladder_exhausted",
    ]);
  });

  it("tells the tier's new assignee once, in the envelope's tenant, with fixed text and ids only", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(event("m36.ack.escalated"));

    expect(emit).toHaveBeenCalledTimes(1);
    const [org, alert] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(org).toBe(ORG);
    expect(alert).toMatchObject({
      eventType: "m36.ack.escalated",
      correlationId: `ack-esc:r-1:1:${TIER_USER}`,
      payload: { recipientUserId: TIER_USER, message: ACK_ESCALATION_NOTIFICATION_TEXT.escalated },
    });
    expect(Object.keys(alert.payload as object).sort()).toEqual(
      [
        "ackClass",
        "channelId",
        "deepLink",
        "message",
        "messageId",
        "recipientUserId",
        "sourceAggregateId",
      ].sort(),
    );
  });

  it("alerts nobody when the request was acknowledged, reassigned or advanced since the event", async () => {
    for (const request of [
      row({ status: "acknowledged" }),
      row({ assignedUserId: "someone-else" }),
      row({ version: 2 }),
      null,
    ]) {
      const { emit, warn, consumer } = setup({ request });
      await consumer.handle(event("m36.ack.escalated"));
      expect(emit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it("skips a new assignee who can no longer see the channel or is no longer qualified", async () => {
    const hidden = setup({ canView: async () => false });
    await hidden.consumer.handle(event("m36.ack.escalated"));
    expect(hidden.emit).not.toHaveBeenCalled();

    const unqualified = setup({ qualified: async () => false });
    await unqualified.consumer.handle(event("m36.ack.escalated"));
    expect(unqualified.emit).not.toHaveBeenCalled();
  });

  it("rethrows a lookup error so the outbox retries", async () => {
    const { consumer } = setup({
      qualified: async () => {
        throw new Error("lookup down");
      },
    });
    await expect(consumer.handle(event("m36.ack.escalated"))).rejects.toThrow("lookup down");
  });

  const alertsOf = (emit: { mock: { calls: unknown[][] } }, eventType: string) =>
    emit.mock.calls
      .map(
        (c) => c[1] as { eventType: string; correlationId: string; payload: Record<string, any> },
      )
      .filter((a) => a.eventType === eventType);

  it("tells the sender and the current assignee when no tier could be reached, one alert per recorded event", async () => {
    const { emit, consumer } = setup({
      request: row({ status: "pending", assignedUserId: "u-2", version: 0 }),
    });

    await consumer.handle(event("m36.ack.route_unavailable", { requestVersion: 0 }));

    const [alert] = alertsOf(emit, "m36.ack.route_unavailable");
    expect(alert).toMatchObject({
      eventType: "m36.ack.route_unavailable",
      correlationId: `ack-unrouted:r-1:0:m36.ack.route_unavailable:${T}`,
      payload: {
        recipientUserIds: [REQUESTER, "u-2"],
        message: ACK_ESCALATION_NOTIFICATION_TEXT.route_unavailable,
      },
    });
  });

  it("says there is no further tier on ladder_exhausted to the parties, and still tells the supervisors when no party can see the channel", async () => {
    const { emit, consumer } = setup({
      request: row({ status: "pending", version: 0 }),
      canView: async () => false,
    });

    await consumer.handle(event("m36.ack.ladder_exhausted", { requestVersion: 0 }));

    expect(alertsOf(emit, "m36.ack.ladder_exhausted")).toHaveLength(0); // nobody to tell among the parties
    expect(alertsOf(emit, "m36.ack.supervisor_attention")).toHaveLength(1);
  });

  it("does not alert about a request that closed since the unrouted event", async () => {
    const { emit, opsNotice, consumer } = setup({
      request: row({ status: "acknowledged", version: 0 }),
    });

    await consumer.handle(event("m36.ack.route_unavailable", { requestVersion: 0 }));

    expect(emit).not.toHaveBeenCalled();
    expect(opsNotice).not.toHaveBeenCalled();
  });

  it("raises the supervisor attention alert and an ops notice on the first record of EACH type only; later records go to the parties alone", async () => {
    const first = setup({ request: row({ status: "pending", version: 0 }) });
    await first.consumer.handle(
      event("m36.ack.ladder_exhausted", { requestVersion: 0, occurrence: 1, typeOccurrence: 1 }),
    );
    const later = setup({ request: row({ status: "pending", version: 0 }) });
    await later.consumer.handle(
      event("m36.ack.ladder_exhausted", { requestVersion: 0, occurrence: 3, typeOccurrence: 2 }),
    );

    expect(alertsOf(first.emit, "m36.ack.supervisor_attention")[0]).toMatchObject({
      correlationId: `ack-attn:r-1:0:ladder_exhausted:${T}`,
      payload: { reason: "ladder_exhausted", ackClass: "urgent" },
    });
    expect(first.opsNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "m36.ack.ladder_exhausted",
        details: { organizationId: ORG, requestId: "r-1", ackClass: "urgent" },
      }),
    );
    expect(alertsOf(later.emit, "m36.ack.supervisor_attention")).toHaveLength(0);
    expect(later.opsNotice).not.toHaveBeenCalled();
    // The parties' reminder keeps its own type and text (the supervisors are no longer on that rule).
    const [again] = alertsOf(later.emit, "m36.ack.ladder_exhausted");
    expect(again?.payload.message).toBe(ACK_ESCALATION_NOTIFICATION_TEXT.ladder_exhausted);
  });

  it("route_unavailable now reaches the supervisors too (G-3), and the first ladder_exhausted after it still does (per-type occurrence)", async () => {
    const { emit, consumer } = setup({ request: row({ status: "pending", version: 0 }) });

    await consumer.handle(
      event("m36.ack.route_unavailable", { requestVersion: 0, occurrence: 1, typeOccurrence: 1 }),
    );
    // The request's 3rd record overall, but the first ladder_exhausted.
    await consumer.handle(
      event("m36.ack.ladder_exhausted", { requestVersion: 0, occurrence: 3, typeOccurrence: 1 }),
    );

    expect(alertsOf(emit, "m36.ack.supervisor_attention").map((a) => a.payload.reason)).toEqual([
      "route_unavailable",
      "ladder_exhausted",
    ]);
  });

  it("degrades visibly: an unpaged supervisor alert raises the unpaged ops notice with ids and codes only", async () => {
    const { opsNotice, consumer } = setup({
      request: row({ status: "pending", version: 0 }),
      planned: 0,
    });

    await consumer.handle(event("m36.ack.ladder_exhausted", { requestVersion: 0 }));

    const unpaged = opsNotice.mock.calls
      .map((c) => c[0] as { kind: string; details: Record<string, unknown> })
      .find((n) => n.kind === "m36.ack.supervisor_unpaged");
    expect(unpaged?.details).toEqual({
      organizationId: ORG,
      requestId: "r-1",
      ackClass: "urgent",
      reason: "ladder_exhausted",
      supervisors: 1,
    });
  });

  it("no party can see the channel at the first record: the warning is logged and the supervisors are still told", async () => {
    const { emit, warn, consumer } = setup({
      request: row({ status: "pending", version: 0 }),
      canView: async () => false,
    });
    await consumer.handle(event("m36.ack.route_unavailable", { requestVersion: 0 }));
    expect(alertsOf(emit, "m36.ack.supervisor_attention")).toHaveLength(1);
    expect(alertsOf(emit, "m36.ack.route_unavailable")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "escalation notification not delivered",
      expect.objectContaining({ reason: "no_recipient_can_view_channel" }),
    );
  });

  it("emits the parties' alert BEFORE the supervisor alert, so a supervisor-side failure cannot delay or lose it (a retry re-emits idempotently)", async () => {
    const { emit, consumer } = setup({ request: row({ status: "pending", version: 0 }) });
    emit.mockImplementation(async (_org: string, a: { eventType: string }) => {
      if (a.eventType === "m36.ack.supervisor_attention") throw new Error("supervisor side down");
      return { alertId: "a", resolvedRecipientCount: 1, outOfBandPlanned: 1 };
    });

    await expect(
      consumer.handle(event("m36.ack.ladder_exhausted", { requestVersion: 0 })),
    ).rejects.toThrow("supervisor side down");

    expect(alertsOf(emit, "m36.ack.ladder_exhausted")).toHaveLength(1);
  });
});
