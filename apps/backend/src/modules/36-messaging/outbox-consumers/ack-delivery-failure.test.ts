// WP 4.5 - the delivery-failed consumer: which failures count, and what it hands the service. The alert type and the message come from the
// persisted rows (the route reader), never from the event payload.
import { describe, expect, it, vi } from "vitest";
import type { DeliveryRouteState } from "../ack-delivery-failure/delivery-route-reader-db";
import { buildM36AckDeliveryFailureConsumer } from "./ack-delivery-failure";

const ORG = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-0000000000b2";
const MESSAGE = "00000000-0000-4000-8000-0000000000f2";
const OTHER_MESSAGE = "00000000-0000-4000-8000-0000000000f9";
const DELIVERY = "00000000-0000-4000-8000-0000000000aa";
const ALERT_AT = new Date("2026-10-15T12:00:01.000Z");

const event = (payload: Record<string, unknown>) =>
  ({ eventType: "m36.notification.delivery_failed", organizationId: ORG, payload }) as never;
const payload = { notificationId: DELIVERY };
const state = (
  routes: DeliveryRouteState["routes"],
  over: Partial<DeliveryRouteState> = {},
): DeliveryRouteState => ({
  alertEventType: "m36.message.urgent_sent",
  sourceMessageId: MESSAGE,
  alertCreatedAt: ALERT_AT,
  recipientUserId: USER,
  routes,
  ...over,
});

function setup(
  routes: DeliveryRouteState["routes"] | null,
  over: Partial<DeliveryRouteState> = {},
) {
  const onAllRoutesFailed = vi.fn(
    async () => ({ kind: "failed_unreachable", requestId: "r", ackClass: "urgent" }) as const,
  );
  const readRoutes = vi.fn(async () => (routes ? state(routes, over) : null));
  const warn = vi.fn();
  const info = vi.fn();
  const opsNotice = vi.fn();
  const consumer = buildM36AckDeliveryFailureConsumer({
    readRoutes,
    service: { onAllRoutesFailed },
    opsNotice,
    warn,
    info,
  });
  return { consumer, onAllRoutesFailed, readRoutes, warn, info, opsNotice };
}

describe("m36.ack-delivery-failure consumer", () => {
  it("reports a failed out-of-band supervisor PAGE to the ops sink (ids and channel only) and never touches the request (ADR-0079)", async () => {
    const ctx = setup([], { alertEventType: "m36.ack.supervisor_attention", channel: "push" });

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
    expect(ctx.opsNotice).toHaveBeenCalledOnce();
    expect(ctx.opsNotice).toHaveBeenCalledWith({
      kind: "m36.ack.supervisor_page_failed",
      summary: expect.any(String),
      details: { organizationId: ORG, deliveryId: DELIVERY, channel: "push" },
      correlationId: `sup-page-failed:${DELIVERY}`,
    });
  });

  it("does not raise the page-failed notice for a failed in-app supervisor row", async () => {
    const ctx = setup([], { alertEventType: "m36.ack.supervisor_attention", channel: "in_app" });

    await ctx.consumer.handle(event(payload));

    expect(ctx.opsNotice).not.toHaveBeenCalled();
    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
  });

  it("declares the delivery-failed event only", () => {
    expect(setup([]).consumer.eventTypes).toEqual(["m36.notification.delivery_failed"]);
  });

  it("acts when push and sms both failed (the simulated outage), ignoring the in-app floor", async () => {
    const ctx = setup([
      { channel: "in_app", status: "delivered" },
      { channel: "push", status: "failed" },
      { channel: "sms", status: "failed" },
    ]);

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).toHaveBeenCalledWith(ORG, {
      messageId: MESSAGE,
      recipientUserId: USER,
      alertCreatedAt: ALERT_AT,
    });
  });

  it("takes the message and the alert type from the stored rows and ignores spoofed payload fields", async () => {
    const ctx = setup([{ channel: "push", status: "failed" }]);

    await ctx.consumer.handle(
      event({
        ...payload,
        alertEventType: "m19.triage.case_opened",
        sourceAggregateId: OTHER_MESSAGE,
      }),
    );

    expect(ctx.onAllRoutesFailed).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ messageId: MESSAGE }),
    );
  });

  it.each([
    ["sms still pending", "pending"],
    ["sms sent but not yet delivered", "sent"],
    ["sms delivered", "delivered"],
    ["sms held for quiet hours", "skipped_quiet_hours"],
    ["sms forwarded", "forwarded"],
  ])("waits when another route is still open (%s), logged at info", async (_label, status) => {
    const ctx = setup([
      { channel: "in_app", status: "delivered" },
      { channel: "push", status: "failed" },
      { channel: "sms", status },
    ]);

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
    expect(ctx.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "other_routes_still_open" }),
    );
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("a failed alert beside a delivered or pending route of ANOTHER assignee alert of the same request does nothing", async () => {
    // The reader aggregates across the message's assignee-facing alerts: one all-failed alert plus one pending sms is not "all failed".
    const ctx = setup([
      { channel: "push", status: "failed" },
      { channel: "sms", status: "pending" },
    ]);

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
  });

  it("does not treat an in-app-only recipient as failed (the floor is not an out-of-band route)", async () => {
    const ctx = setup([{ channel: "in_app", status: "failed" }]);

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
  });

  it.each([
    "m19.triage.case_opened",
    "m36.ack.route_unavailable",
    "m36.ack.ladder_exhausted",
    "m36.ack.failed_unreachable",
  ])("ignores an alert that is not a request telling its assignee (%s)", async (alertEventType) => {
    const ctx = setup([{ channel: "push", status: "failed" }], { alertEventType });

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).not.toHaveBeenCalled();
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it.each([
    "m36.ack.requested",
    "m36.ack.reassigned",
    "m36.ack.escalated",
    "m36.message.urgent_sent",
  ])("handles %s", async (alertEventType) => {
    const ctx = setup([{ channel: "push", status: "failed" }], { alertEventType });

    await ctx.consumer.handle(event(payload));

    expect(ctx.onAllRoutesFailed).toHaveBeenCalledOnce();
  });

  it("warns with an id-only reason when the alert names no message or the delivery is gone", async () => {
    const noMessage = setup([{ channel: "push", status: "failed" }], { sourceMessageId: null });
    await noMessage.consumer.handle(event(payload));
    const gone = setup(null);
    await gone.consumer.handle(event(payload));

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

    await expect(ctx.consumer.handle(event(payload))).rejects.toThrow("db blip");
  });
});
