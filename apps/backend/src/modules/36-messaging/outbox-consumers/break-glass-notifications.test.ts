// ADR-0087 S3 - the break-glass notification consumer: one fixed-text alert per grant, no name or reason in it, idempotent on the grant id,
// and a failed emit propagates so the relay redelivers.
import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  BREAK_GLASS_GRANTED_ALERT_TEXT,
  BREAK_GLASS_REVIEW_DEEP_LINK,
  M36_BREAK_GLASS_NOTIFICATION_CONSUMER,
  buildM36BreakGlassNotificationsConsumer,
} from "./break-glass-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const PAYLOAD = {
  organizationId: ORG,
  grantId: GRANT,
  channelId: "33333333-3333-4333-8333-333333333333",
  granteeUserId: "44444444-4444-4444-8444-444444444444",
  reasonCode: "patient_safety",
  grantedAt: "2026-10-21T10:00:00.000Z",
  expiresAt: "2026-10-21T14:00:00.000Z",
};

function setup(
  emit: AlertEmitter["emit"] = async () => ({ alertId: "a", resolvedRecipientCount: 1 }),
) {
  const spy = vi.fn(emit);
  const consumer = buildM36BreakGlassNotificationsConsumer({ alerts: { emit: spy } });
  const event = (eventType: string, payload: unknown = PAYLOAD) =>
    ({ id: "e1", eventType, organizationId: ORG, payload }) as never;
  return { consumer, spy, event };
}

describe("m36 break-glass notifications consumer", () => {
  it("is named for the m36 module and consumes only the granted event", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_BREAK_GLASS_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes]).toEqual(["m36.break_glass.granted"]);
  });

  it("emits one generic warn alert keyed on the grant, with no name, title or free text", async () => {
    const { consumer, spy, event } = setup();
    await consumer.handle(event("m36.break_glass.granted"));
    expect(spy).toHaveBeenCalledTimes(1);
    const [org, input] = spy.mock.calls[0] as [string, Parameters<AlertEmitter["emit"]>[1]];
    expect(org).toBe(ORG);
    expect(input).toMatchObject({
      eventType: "m36.break_glass.granted",
      severity: "warn",
      correlationId: `break-glass:${GRANT}:granted`,
    });
    expect(input.payload).toEqual({
      grantId: GRANT,
      channelId: PAYLOAD.channelId,
      granteeUserId: PAYLOAD.granteeUserId,
      reasonCode: "patient_safety",
      expiresAt: PAYLOAD.expiresAt,
      message: BREAK_GLASS_GRANTED_ALERT_TEXT,
      deepLink: BREAK_GLASS_REVIEW_DEEP_LINK,
    });
    expect(JSON.stringify(input.payload)).not.toMatch(/justification|note|name|title/i);
  });

  it("a redelivery uses the same correlation id (the alert dedupe absorbs it)", async () => {
    const { consumer, spy, event } = setup();
    await consumer.handle(event("m36.break_glass.granted"));
    await consumer.handle(event("m36.break_glass.granted"));
    const ids = spy.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(1);
  });

  it("ignores the trail-only events", async () => {
    const { consumer, spy, event } = setup();
    await consumer.handle(event("m36.break_glass.revoked"));
    await consumer.handle(event("m36.break_glass.reviewed"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a payload without a grant id, and a failed emit propagates (the relay retries)", async () => {
    const ok = setup();
    await expect(
      ok.consumer.handle(ok.event("m36.break_glass.granted", { organizationId: ORG })),
    ).rejects.toThrow(/missing grantId/);
    const down = setup(async () => {
      throw new Error("alert seam down");
    });
    await expect(down.consumer.handle(down.event("m36.break_glass.granted"))).rejects.toThrow(
      "alert seam down",
    );
  });
});
