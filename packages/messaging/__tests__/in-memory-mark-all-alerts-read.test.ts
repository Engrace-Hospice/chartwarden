// markAllAlertsRead on the in-memory twin: marks only the actor's unread alerts, idempotently.
import { describe, expect, it } from "vitest";
import type { AlertInboxItem } from "../src/interfaces/route-service";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOBODY = "44444444-4444-4444-8444-444444444444";
const EARLIER = "2026-01-01T00:00:00.000Z";

const alert = (alertId: string, readAt: string | null): AlertInboxItem => ({
  alertId,
  eventType: "test.event",
  category: "operational",
  severity: "info",
  summary: "synthetic alert",
  deepLink: null,
  createdAt: EARLIER,
  deliveryStatus: "delivered",
  readAt,
});

const build = () =>
  createInMemoryMessagingService({
    seed: {
      alerts: [
        { orgId: ORG, userId: ME, item: alert("a1", null) },
        { orgId: ORG, userId: ME, item: alert("a2", EARLIER) },
        { orgId: ORG, userId: OTHER, item: alert("a3", null) },
      ],
    },
  });

describe("in-memory markAllAlertsRead", () => {
  it("marks the actor's unread alerts, keeps an earlier read time, and leaves other users alone", async () => {
    const svc = build();
    await svc.markAllAlertsRead(ORG, ME);

    const mine = await svc.alertInbox(ORG, ME);
    expect(mine.every((a) => a.readAt !== null)).toBe(true);
    expect(mine.find((a) => a.alertId === "a2")?.readAt).toBe(EARLIER);
    expect((await svc.alertInbox(ORG, OTHER))[0]?.readAt).toBeNull();
  });

  it("is idempotent and a no-op for an empty inbox", async () => {
    const svc = build();
    await svc.markAllAlertsRead(ORG, ME);
    const first = await svc.alertInbox(ORG, ME);
    await svc.markAllAlertsRead(ORG, ME);
    expect(await svc.alertInbox(ORG, ME)).toEqual(first);
    await expect(svc.markAllAlertsRead(ORG, NOBODY)).resolves.toBeUndefined();
  });
});
