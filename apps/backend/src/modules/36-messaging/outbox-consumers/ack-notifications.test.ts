import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  ACK_NOTIFICATION_TEXT,
  M36_ACK_NOTIFICATION_CONSUMER,
  buildM36AckNotificationsConsumer,
} from "./ack-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
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
      ackClass: "important",
      assignedUserId: "u-2",
      actorUserId: "u-1",
      requestVersion: 0,
      at: "2026-10-15T12:00:00.000Z",
      ...payload,
    },
  }) as never;

function setup(
  over: {
    canView?: () => Promise<boolean>;
    open?: (...args: unknown[]) => Promise<boolean>;
    qualified?: () => Promise<boolean>;
  } = {},
) {
  const warn = vi.fn();
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
  const consumer = buildM36AckNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    messaging: { canViewChannel: over.canView ?? (async () => true) },
    isWaitingForAssignee: over.open ?? (async () => true),
    stillQualified: over.qualified ?? (async () => true),
    warn,
  });
  return { emit, warn, consumer };
}

describe("M36 acknowledgment-request notifications consumer", () => {
  it("subscribes only to requested and reassigned under its own name", () => {
    const { consumer } = setup();

    expect(consumer.consumerName).toBe(M36_ACK_NOTIFICATION_CONSUMER);
    expect(consumer.eventTypes).toEqual(["m36.ack.requested", "m36.ack.reassigned"]);
  });

  it("alerts the assignee of an important request once, in the envelope's tenant, with fixed text and ids only", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(event("m36.ack.requested"));

    expect(emit).toHaveBeenCalledTimes(1);
    const [org, alert] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(org).toBe(ORG);
    expect(alert).toMatchObject({
      eventType: "m36.ack.requested",
      severity: "warn",
      correlationId: "ack:r-1:0:u-2",
      payload: { recipientUserId: "u-2", message: ACK_NOTIFICATION_TEXT.requested },
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

  it("stays silent for an urgent request: the WP 4.1 alert already told the recipient", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(event("m36.ack.requested", { ackClass: "urgent" }));

    expect(emit).not.toHaveBeenCalled();
  });

  it("alerts the NEW assignee of a reassign whatever the class, with its own correlation id", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(
      event("m36.ack.reassigned", { ackClass: "urgent", requestVersion: 2, assignedUserId: "u-3" }),
    );

    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      correlationId: "ack:r-1:2:u-3",
      payload: { recipientUserId: "u-3", message: ACK_NOTIFICATION_TEXT.reassigned },
    });
  });

  it("asks whether the request is still waiting for THIS assignee at THIS event's version", async () => {
    const open = vi.fn().mockResolvedValue(true);
    const { consumer } = setup({ open });

    await consumer.handle(event("m36.ack.requested"));

    expect(open).toHaveBeenCalledWith(ORG, "r-1", "u-2", 0);
  });

  it("a redelivery converges on the same correlation id", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(event("m36.ack.requested"));
    await consumer.handle(event("m36.ack.requested"));

    expect(emit.mock.calls[0]?.[1]).toMatchObject({ correlationId: "ack:r-1:0:u-2" });
    expect(emit.mock.calls[1]?.[1]).toMatchObject({ correlationId: "ack:r-1:0:u-2" });
  });

  it.each([
    [
      "the request is closed or reassigned since",
      { open: async () => false },
      "request_not_waiting_for_assignee",
    ],
    [
      "the recipient cannot see the channel",
      { canView: async () => false },
      "recipient_cannot_view_channel",
    ],
    [
      "the recipient is no longer qualified",
      { qualified: async () => false },
      "recipient_not_qualified",
    ],
  ])("a clean no is a quiet id-only skip when %s", async (_label, over, reason) => {
    const { emit, warn, consumer } = setup(over);

    await consumer.handle(event("m36.ack.reassigned"));

    expect(emit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason, requestId: "r-1" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Rita|patient/i);
  });

  it.each([
    ["the open-request lookup", { open: async () => Promise.reject(new Error("db blip")) }],
    ["the channel lookup", { canView: async () => Promise.reject(new Error("db blip")) }],
    ["the qualification lookup", { qualified: async () => Promise.reject(new Error("db blip")) }],
  ])(
    "rethrows when %s fails so the outbox retries (an alert is never dropped on a blip)",
    async (_label, over) => {
      const { emit, consumer } = setup(over);

      await expect(consumer.handle(event("m36.ack.requested"))).rejects.toThrow("db blip");
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed payload loudly (the dispatcher dead-letters it)", async () => {
    const { consumer } = setup();

    await expect(
      consumer.handle(event("m36.ack.requested", { requestId: undefined })),
    ).rejects.toThrow(/missing requestId/);
    await expect(
      consumer.handle(event("m36.ack.requested", { requestVersion: "1" })),
    ).rejects.toThrow(/missing requestVersion/);
  });
});

describe("ADR-0078: a supervisor's reassign also tells the previous assignee and the sender", () => {
  const supervised = {
    actorUserId: "sup-1",
    previousAssignedUserId: "u-0",
    requesterUserId: "u-1",
    supervisorReassign: true,
    requestVersion: 3,
  };

  it("emits the new assignee's alert as usual plus ONE generic in-app notice for the previous assignee and the sender", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(event("m36.ack.reassigned", supervised));

    expect(emit).toHaveBeenCalledTimes(2);
    const notice = emit.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((a) => a.eventType === "m36.ack.supervisor_reassigned");
    expect(notice).toMatchObject({
      severity: "warn",
      correlationId: "ack-sup:r-1:3",
      payload: {
        recipientUserIds: ["u-0", "u-1"],
        message: ACK_NOTIFICATION_TEXT.supervisorReassigned,
      },
    });
    expect(Object.keys(notice?.payload as object).sort()).toEqual(
      ["channelId", "deepLink", "message", "messageId", "recipientUserIds"].sort(),
    );
    const own = emit.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((a) => a.eventType === "m36.ack.reassigned");
    expect(own).toMatchObject({ payload: { recipientUserId: "u-2" } });
  });

  it("never names the supervisor, a reason or a person in the text", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(event("m36.ack.reassigned", supervised));

    const text = JSON.stringify(emit.mock.calls);
    expect(text).not.toContain("sup-1");
    expect(ACK_NOTIFICATION_TEXT.supervisorReassigned).not.toMatch(/reason|unreachable|workload/i);
  });

  it("leaves the supervisor out when they were the previous assignee or the sender, and skips people who cannot see the channel", async () => {
    const { emit, consumer } = setup({
      canView: async () => false,
    });

    await consumer.handle(
      event("m36.ack.reassigned", { ...supervised, previousAssignedUserId: "sup-1" }),
    );

    // Nobody can see the channel: no notice at all, and the new assignee is skipped too (existing rule).
    expect(emit).not.toHaveBeenCalled();
  });

  it("sends no notice for a reassign made by the sender or the assignee", async () => {
    const { emit, consumer } = setup();

    await consumer.handle(
      event("m36.ack.reassigned", { previousAssignedUserId: "u-0", requesterUserId: "u-1" }),
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0]?.[1] as Record<string, unknown>).eventType).toBe(
      "m36.ack.reassigned",
    );
  });

  it("tells the others even when the new assignee's alert is skipped as stale", async () => {
    const { emit, consumer } = setup({ open: async () => false });

    await consumer.handle(event("m36.ack.reassigned", supervised));

    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0]?.[1] as Record<string, unknown>).eventType).toBe(
      "m36.ack.supervisor_reassigned",
    );
  });
});
