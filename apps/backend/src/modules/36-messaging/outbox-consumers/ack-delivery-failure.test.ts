// WP 4.5 - the delivery-failed consumer: which failures count, and what it hands the service.
import { describe, expect, it, vi } from "vitest";
import type { DeliveryRouteState } from "../ack-delivery-failure/delivery-route-reader-db";
import { buildM36AckDeliveryFailureConsumer } from "./ack-delivery-failure";

const ORG = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-0000000000b2";
const MESSAGE = "00000000-0000-4000-8000-0000000000f2";
const DELIVERY = "00000000-0000-4000-8000-0000000000aa";
const ALERT_AT = new Date("2026-10-15T12:00:01.000Z");

const event = (payload: Record<string, unknown>) =>
  ({ eventType: "m36.notification.delivery_failed", organizationId: ORG, payload }) as never;
const basePayload = {
  notificationId: DELIVERY,
  alertEventType: "m36.message.urgent_sent",
  sourceAggregateId: MESSAGE,
};
const state = (routes: DeliveryRouteState["routes"]): DeliveryRouteState => ({
  alertEventType: "m36.message.urgent_sent",
  alertCreatedAt: ALERT_AT,
  recipientUserId: USER,
  routes,
});

function setup(routes: DeliveryRouteState["routes"] | null) {
  const onAllRoutesFailed = vi.fn(
    async () => ({ kind: "failed_unreachable", requestId: "r", ackClass: "urgent" }) as const,
  );
  const readRoutes = vi.fn(async () => (routes ? state(routes) : null));
  const warn = vi.fn();
  const consumer = buildM36AckDeliveryFailureConsumer({
    readRoutes,
    service: { onAllRoutesFailed },
    warn,
  });
  return { consumer, onAllRoutesFailed, readRoutes, warn };
}

describe("m36.ack-delivery-failure consumer", () => {
  it("declares the delivery-failed event only", () => {
    expect(setup([]).consumer.eventTypes).toEqual(["m36.notification.delivery_failed"]);
  });

  it("acts when push and sms both failed (the simulated outage), ignoring the in-app floor", async () => {
    const ctx = setup([
      { channel: "in_app", status: "delivered" },
      { channel: "push", status: "failed" },
      { channel: "sms", status: "failed" },
    ]);

    await ctx.consumer.handle(event(basePayload));

    expect(ctx.onAllRoutesFailed).toHaveBeenCalledWith(ORG, {
      messageId: MESSAGE,
      recipientUserId: USER,
      alertCreatedAt: ALERT_AT,
    });
  });

  it.each([
    ["sms still pending", "pending"],
    ["sms sent but not yet delivered", "sent"],
    ["sms delivered", "delivered"],
    ["sms held for quiet hours", "skipped_quiet_hours"],
    ["sms forwarded", "forwarded"],
  ])("waits when another route is still open (%s)", async (_label, status) => {
    const ctx = setup([
      { channel: "in_app", status: "delivered" },
      { channel: "push", status: "failed" },
      { channel: "sms", status },
    ]);

    await ctx.consumer.handle(event(basePayload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
  });

  it("does not treat an in-app-only recipient as failed (the floor is not an out-of-band route)", async () => {
    const ctx = setup([{ channel: "in_app", status: "failed" }]);

    await ctx.consumer.handle(event(basePayload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
  });

  it.each([
    "m19.triage.case_opened",
    "m36.ack.route_unavailable",
    "m36.ack.ladder_exhausted",
    "m36.ack.failed_unreachable",
    null,
  ])(
    "ignores an alert that is not a request telling its assignee (%s) without reading anything",
    async (alertEventType) => {
      const ctx = setup([{ channel: "push", status: "failed" }]);

      await ctx.consumer.handle(event({ ...basePayload, alertEventType }));

      expect(ctx.readRoutes).not.toHaveBeenCalled();
      expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
    },
  );

  it.each([
    "m36.ack.requested",
    "m36.ack.reassigned",
    "m36.ack.escalated",
    "m36.message.urgent_sent",
  ])("handles %s", async (alertEventType) => {
    const ctx = setup([{ channel: "push", status: "failed" }]);

    await ctx.consumer.handle(event({ ...basePayload, alertEventType }));

    expect(ctx.onAllRoutesFailed).toHaveBeenCalledOnce();
  });

  it("skips with an id-only warning when the alert carries no message or the delivery is gone", async () => {
    const noMessage = setup([{ channel: "push", status: "failed" }]);
    await noMessage.consumer.handle(event({ ...basePayload, sourceAggregateId: null }));
    const gone = setup(null);
    await gone.consumer.handle(event(basePayload));

    expect(noMessage.onAllRoutesFailed).not.toHaveBeenCalled();
    expect(gone.onAllRoutesFailed).not.toHaveBeenCalled();
    expect(noMessage.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "alert_has_no_message" }),
    );
    expect(gone.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "delivery_not_found" }),
    );
  });

  it("rethrows a service error so the outbox retries", async () => {
    const ctx = setup([{ channel: "push", status: "failed" }]);
    ctx.onAllRoutesFailed.mockRejectedValueOnce(new Error("db blip"));

    await expect(ctx.consumer.handle(event(basePayload))).rejects.toThrow("db blip");
  });
});
