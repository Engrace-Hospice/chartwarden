import { describe, expect, it, vi } from "vitest";
import { M36_ACK_TIMER_ARMING_CONSUMER, buildM36AckTimerArmingConsumer } from "./ack-timer-arming";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("M36 ack timer arming consumer", () => {
  it("subscribes to requested, reassigned and escalated", () => {
    const consumer = buildM36AckTimerArmingConsumer({ armFromRequest: async () => {} });
    expect(consumer.consumerName).toBe(M36_ACK_TIMER_ARMING_CONSUMER);
    expect(consumer.eventTypes).toEqual([
      "m36.ack.requested",
      "m36.ack.reassigned",
      "m36.ack.escalated",
    ]);
  });

  it("arms the request named by the payload in the envelope's tenant, never the payload's", async () => {
    const armFromRequest = vi.fn().mockResolvedValue(undefined);
    const consumer = buildM36AckTimerArmingConsumer({ armFromRequest });

    await consumer.handle({
      id: "e",
      eventType: "m36.ack.requested",
      organizationId: ORG,
      payload: { requestId: "r-1", organizationId: "attacker" },
    } as never);

    expect(armFromRequest).toHaveBeenCalledWith(ORG, "r-1");
  });

  it("rethrows an arming failure so the outbox retries, and refuses a payload without a request id", async () => {
    const consumer = buildM36AckTimerArmingConsumer({
      armFromRequest: async () => {
        throw new Error("redis down");
      },
    });
    const event = (payload: unknown) =>
      ({ id: "e", eventType: "m36.ack.requested", organizationId: ORG, payload }) as never;

    await expect(consumer.handle(event({ requestId: "r-1" }))).rejects.toThrow("redis down");
    await expect(consumer.handle(event({}))).rejects.toThrow("missing requestId");
  });
});
