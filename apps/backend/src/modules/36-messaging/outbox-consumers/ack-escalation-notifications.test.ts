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
  } = {},
) {
  const warn = vi.fn();
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
  const consumer = buildM36AckEscalationNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    messaging: {
      canViewChannel: async (_o, userId) => (over.canView ?? (async () => true))(userId),
    },
    readRequest: async () => (over.request === undefined ? row() : over.request),
    stillQualified: over.qualified ?? (async () => true),
    warn,
  });
  return { emit, warn, consumer };
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

  it("tells the sender and the current assignee when no tier could be reached, one alert per recorded event", async () => {
    const { emit, consumer } = setup({
      request: row({ status: "pending", assignedUserId: "u-2", version: 0 }),
    });

    await consumer.handle(event("m36.ack.route_unavailable", { requestVersion: 0 }));

    const [, alert] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(alert).toMatchObject({
      eventType: "m36.ack.route_unavailable",
      correlationId: `ack-unrouted:r-1:0:m36.ack.route_unavailable:${T}`,
      payload: {
        recipientUserIds: [REQUESTER, "u-2"],
        message: ACK_ESCALATION_NOTIFICATION_TEXT.route_unavailable,
      },
    });
  });

  it("says there is no further tier on ladder_exhausted and still alerts when the supervisors are the only audience", async () => {
    const { emit, consumer } = setup({
      request: row({ status: "pending", version: 0 }),
      canView: async () => false,
    });

    await consumer.handle(event("m36.ack.ladder_exhausted", { requestVersion: 0 }));

    const [, alert] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(alert.payload).toMatchObject({
      recipientUserIds: [],
      message: ACK_ESCALATION_NOTIFICATION_TEXT.ladder_exhausted,
    });
  });

  it("does not alert about a request that closed since the unrouted event", async () => {
    const { emit, consumer } = setup({ request: row({ status: "acknowledged", version: 0 }) });

    await consumer.handle(event("m36.ack.route_unavailable", { requestVersion: 0 }));

    expect(emit).not.toHaveBeenCalled();
  });

  it("tells the supervisor audience of an exhausted ladder on the first record only; later records go to the parties under the not-routed rule", async () => {
    const first = setup({ request: row({ status: "pending", version: 0 }) });
    await first.consumer.handle(
      event("m36.ack.ladder_exhausted", { requestVersion: 0, occurrence: 1, typeOccurrence: 1 }),
    );
    const later = setup({ request: row({ status: "pending", version: 0 }) });
    await later.consumer.handle(
      event("m36.ack.ladder_exhausted", { requestVersion: 0, occurrence: 3, typeOccurrence: 2 }),
    );

    expect((first.emit.mock.calls[0] as [string, { eventType: string }])[1].eventType).toBe(
      "m36.ack.ladder_exhausted",
    );
    const [, again] = later.emit.mock.calls[0] as [
      string,
      { eventType: string; payload: { message: string } },
    ];
    expect(again.eventType).toBe("m36.ack.route_unavailable");
    expect(again.payload.message).toBe(ACK_ESCALATION_NOTIFICATION_TEXT.ladder_exhausted);
  });

  it("a route_unavailable record first does not cost the supervisors their alert: the first ladder_exhausted (per-type occurrence 1) still reaches them", async () => {
    const { emit, consumer } = setup({ request: row({ status: "pending", version: 0 }) });

    // The request's 3rd record overall, but the first ladder_exhausted.
    await consumer.handle(
      event("m36.ack.ladder_exhausted", { requestVersion: 0, occurrence: 3, typeOccurrence: 1 }),
    );

    expect((emit.mock.calls[0] as [string, { eventType: string }])[1].eventType).toBe(
      "m36.ack.ladder_exhausted",
    );
  });
});
