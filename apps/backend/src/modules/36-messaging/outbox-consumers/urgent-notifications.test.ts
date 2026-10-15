import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  M36_URGENT_NOTIFICATION_CONSUMER,
  URGENT_NOTIFICATION_TEXT,
  buildM36UrgentNotificationsConsumer,
} from "./urgent-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (payload: Record<string, unknown> = {}) =>
  ({
    id: "evt-1",
    eventType: "m36.message.urgent_sent",
    organizationId: ORG,
    payload: {
      organizationId: "attacker-copy-is-ignored",
      channelId: "ch-1",
      messageId: "m-1",
      authorUserId: "u-1",
      recipientUserId: "u-2",
      ...payload,
    },
  }) as never;

function setup(canView = true) {
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
  const canViewChannel = vi.fn().mockResolvedValue(canView);
  const consumer = buildM36UrgentNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    messaging: { canViewChannel },
  });
  return { emit, canViewChannel, consumer };
}

describe("M36 urgent notifications consumer", () => {
  it("subscribes only to the urgent-sent event under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_URGENT_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect(consumer.eventTypes).toEqual(["m36.message.urgent_sent"]);
  });

  it("alerts the recipient once, in the envelope's tenant, with fixed text and ids only", async () => {
    const { emit, canViewChannel, consumer } = setup();
    await consumer.handle(event());
    expect(canViewChannel).toHaveBeenCalledWith(ORG, "u-2", "ch-1");
    expect(emit).toHaveBeenCalledTimes(1);
    const [org, alert] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(org).toBe(ORG);
    expect(alert).toMatchObject({
      eventType: "m36.message.urgent_sent",
      severity: "warn",
      correlationId: "urgent:m-1:u-2",
      payload: {
        recipientUserId: "u-2",
        channelId: "ch-1",
        messageId: "m-1",
        message: URGENT_NOTIFICATION_TEXT,
      },
    });
    expect(Object.keys(alert.payload as object).sort()).toEqual(
      ["channelId", "deepLink", "message", "messageId", "recipientUserId"].sort(),
    );
  });

  it("a redelivery converges on the same correlation id", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event());
    await consumer.handle({ ...(event() as object), id: "evt-2" } as never);
    const ids = emit.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(1);
  });

  it("alerts nobody when the recipient has lost access to the channel", async () => {
    const { emit, consumer } = setup(false);
    await consumer.handle(event());
    expect(emit).not.toHaveBeenCalled();
  });

  it("throws on a payload missing the recipient so the dispatcher retries and dead-letters it", async () => {
    const { consumer } = setup();
    await expect(consumer.handle(event({ recipientUserId: "" }))).rejects.toThrow(
      /recipientUserId/,
    );
  });
});
