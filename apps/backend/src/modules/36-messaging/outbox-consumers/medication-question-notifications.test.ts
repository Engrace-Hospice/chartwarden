import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  M36_MEDICATION_QUESTION_NOTIFICATION_CONSUMER,
  MEDICATION_QUESTION_NOTIFICATION_TEXT,
  buildM36MedicationQuestionNotificationsConsumer,
} from "./medication-question-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (payload: Record<string, unknown> = {}, id = "evt-1") =>
  ({
    id,
    eventType: "m36.medication_question.unrouted",
    organizationId: ORG,
    payload: {
      organizationId: "attacker-copy-is-ignored",
      channelId: "ch-1",
      messageId: "m-1",
      askedByUserId: "u-1",
      reason: "no_nurse",
      at: "2026-01-01T00:00:00.000Z",
      ...payload,
    },
  }) as never;

function setup() {
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
  const consumer = buildM36MedicationQuestionNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
  });
  return { emit, consumer };
}

describe("M36 medication-question notifications consumer", () => {
  it("subscribes to the unrouted event under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_MEDICATION_QUESTION_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes]).toEqual(["m36.medication_question.unrouted"]);
  });

  it("emits one warn alert with fixed text, the envelope tenant and an ids-only payload", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(ORG, {
      eventType: "m36.medication_question.unrouted",
      severity: "warn",
      correlationId: expect.stringMatching(/^medication-question:ch-1:u-1:\d+$/),
      payload: {
        channelId: "ch-1",
        messageId: "m-1",
        message: MEDICATION_QUESTION_NOTIFICATION_TEXT,
        deepLink: "/messaging?channelId=ch-1&messageId=m-1",
      },
    });
  });

  it("uses the same correlation id on a redelivery of the same event so the alert converges", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event());
    await consumer.handle(event());
    const ids = emit.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(1);
  });

  it("converges a burst by one asker in one channel on one alert id, but not another asker, channel or window", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event({ messageId: "m-1" }, "e1"));
    await consumer.handle(event({ messageId: "m-2", at: "2026-01-01T00:09:00.000Z" }, "e2"));
    await consumer.handle(event({ askedByUserId: "u-2" }, "e3"));
    await consumer.handle(event({ channelId: "ch-2" }, "e4"));
    await consumer.handle(event({ at: "2026-01-01T00:11:00.000Z" }, "e5"));
    const ids = emit.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);
  });

  it("falls back to a per-event id when the event stamp is unreadable", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event({ at: "garbage", messageId: "m-9" }, "e9"));
    expect((emit.mock.calls[0]?.[1] as { correlationId: string }).correlationId).toBe(
      "medication-question:m-9:e9",
    );
  });

  it("throws on a payload without a channel id so the dispatcher retries rather than dropping it", async () => {
    const { consumer } = setup();
    await expect(consumer.handle(event({ channelId: "" }))).rejects.toThrow(/channelId/);
  });
});
