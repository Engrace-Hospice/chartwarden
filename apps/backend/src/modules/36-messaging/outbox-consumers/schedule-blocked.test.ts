import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import { buildM36ScheduleBlockedConsumer } from "./schedule-blocked";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (overrides: Record<string, unknown> = {}) =>
  ({
    eventType: "m36.message.schedule_blocked",
    organizationId: ORG,
    payload: {
      organizationId: "attacker-copy-is-ignored",
      scheduledMessageId: "sched-1",
      channelId: "channel-1",
      senderUserId: "user-1",
      reason: "not_member",
      ...overrides,
    },
  }) as never;

describe("M36 scheduled-send blocked consumer", () => {
  it("emits one generic in-app alert to the sender, with no channel, patient or message content", async () => {
    const emit = vi.fn().mockResolvedValue({ alertId: "alert-1", resolvedRecipientCount: 1 });
    const consumer = buildM36ScheduleBlockedConsumer({
      alerts: { emit } as unknown as AlertEmitter,
    });

    await consumer.handle(event());

    expect(emit).toHaveBeenCalledTimes(1);
    const [org, input] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(org).toBe(ORG); // the envelope's tenant, never the payload's
    expect(input).toMatchObject({
      eventType: "m36.message.schedule_blocked",
      correlationId: "schedule-blocked:sched-1",
      payload: {
        senderUserId: "user-1",
        deepLink: "/messaging?scheduled=1",
        message: expect.stringMatching(/scheduled message was not sent/i),
      },
    });
    const text = JSON.stringify(input);
    expect(text).not.toContain("channel-1");
    expect(text).not.toContain("not_member");
  });

  it("is idempotent per scheduled message: a redelivery re-emits the same correlation id", async () => {
    const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
    const consumer = buildM36ScheduleBlockedConsumer({
      alerts: { emit } as unknown as AlertEmitter,
    });
    await consumer.handle(event());
    await consumer.handle(event());
    expect(emit.mock.calls[0]?.[1].correlationId).toBe(emit.mock.calls[1]?.[1].correlationId);
  });

  it("throws on a malformed payload so the relay retries it into the DLQ, never a silent miss", async () => {
    const emit = vi.fn();
    const consumer = buildM36ScheduleBlockedConsumer({
      alerts: { emit } as unknown as AlertEmitter,
    });
    await expect(consumer.handle(event({ senderUserId: "" }))).rejects.toThrow(/senderUserId/);
    await expect(consumer.handle(event({ reason: "made_up" }))).rejects.toThrow(/reason/);
    expect(emit).not.toHaveBeenCalled();
  });
});
