// GAP-043 - M36's consumer of the listener-health events: one page per OUTAGE, a paired recovered notice, no host/port/cert
// in the alert, and a malformed event throws (relay retry -> DLQ) instead of dropping the page.
import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";

import { buildM36FeedHealthAlertConsumer, planFeedHealthAlert } from "./feed-health-alerts";

describe("M36 feed-health-alerts consumer", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const event = (eventType: string, payload: Record<string, unknown>) =>
    ({ eventType, organizationId: ORG, payload }) as never;
  const payload = {
    feedId: "feed-1",
    outageOpenedAt: "2026-10-08T11:00:00.000Z",
    at: "2026-10-08T11:00:00.000Z",
    silentSeconds: 400,
    lastFrameAt: "2026-10-08T10:53:00.000Z",
    heartbeatStale: true,
  };

  it("pages once per OUTAGE: critical, keyed by the instant the outage opened", () => {
    const plan = planFeedHealthAlert(event("m29.external_feed.listener_down", payload));
    expect(plan).toMatchObject({
      alertType: "external_feed.listener_down",
      severity: "critical",
      correlationId: "outbox:external_feed.listener_down:feed-1:2026-10-08T11:00:00.000Z",
    });
    // a second outage of the same feed is a different key, so it pages again
    const second = planFeedHealthAlert(
      event("m29.external_feed.listener_down", {
        ...payload,
        outageOpenedAt: "2026-10-09T01:00:00.000Z",
      }),
    );
    expect(second.correlationId).not.toBe(plan.correlationId);
  });
  it("the recovered notice is info and shares its outage's key", () => {
    const plan = planFeedHealthAlert(event("m29.external_feed.listener_recovered", payload));
    expect(plan).toMatchObject({
      alertType: "external_feed.listener_recovered",
      severity: "info",
      correlationId: "outbox:external_feed.listener_recovered:feed-1:2026-10-08T11:00:00.000Z",
    });
  });
  it("the alert payload names no host, port or certificate", () => {
    const plan = planFeedHealthAlert(event("m29.external_feed.listener_down", payload));
    expect(Object.keys(plan.payload).sort()).toEqual(
      [
        "at",
        "detail",
        "eventType",
        "feedId",
        "heartbeatStale",
        "lastFrameAt",
        "outageOpenedAt",
        "silentSeconds",
      ].sort(),
    );
  });
  it("throws on a malformed event so the relay retries to the DLQ rather than dropping a page", () => {
    expect(() =>
      planFeedHealthAlert(event("m29.external_feed.listener_down", { ...payload, feedId: "" })),
    ).toThrow(/feedId/);
    expect(() =>
      planFeedHealthAlert(
        event("m29.external_feed.listener_down", { ...payload, outageOpenedAt: undefined }),
      ),
    ).toThrow(/outageOpenedAt/);
    expect(() => planFeedHealthAlert(event("m29.something_else", payload))).toThrow(
      /unexpected event/,
    );
  });
  it("emits for the envelope's org (never the payload's) through the AlertEmitter", async () => {
    const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 2 });
    const consumer = buildM36FeedHealthAlertConsumer({ emit } as unknown as AlertEmitter);
    expect(consumer.eventTypes).toEqual([
      "m29.external_feed.listener_down",
      "m29.external_feed.listener_recovered",
    ]);
    await consumer.handle(
      event("m29.external_feed.listener_down", { ...payload, organizationId: "attacker-org" }),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(ORG);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      eventType: "external_feed.listener_down",
      severity: "critical",
    });
  });
});
