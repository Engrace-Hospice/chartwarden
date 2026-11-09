/**
 * `GET /api/admin/webhooks/stripe/recent` pages a list whose tie-breaker is `stripe_webhook_event.id`: a TEXT Stripe event id
 * (`evt_...`), not a uuid. Every other M35 list pages on a uuid, and the shared page helper checked the cursor's id as a uuid, so
 * page 1 answered and page 2 (the cursor the page itself had just minted) was a 422 INVALID_CURSOR. Inherited from main.
 * This walks the real route service across two pages with real-shaped event ids.
 */
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { buildDrizzleM35RouteService } from "../src/modules/35-subscription/routes/service-drizzle";

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 6, 12, minute, 0));
/** Newest first, as the service's `ORDER BY received_at DESC` hands them over. */
const ROWS = [
  { id: "evt_1QzXkL2eZvKYlo2C0aaaaaaa", eventType: "invoice.paid", receivedAt: at(5) },
  { id: "evt_1QzXkL2eZvKYlo2C0bbbbbbb", eventType: "invoice.created", receivedAt: at(4) },
  { id: "evt_1QzXkL2eZvKYlo2C0ccccccc", eventType: "customer.updated", receivedAt: at(3) },
  { id: "evt_1QzXkL2eZvKYlo2C0ddddddd", eventType: "invoice.paid", receivedAt: at(2) },
  { id: "evt_1QzXkL2eZvKYlo2C0eeeeeee", eventType: "charge.succeeded", receivedAt: at(1) },
].map((r) => ({
  ...r,
  processedAt: null,
  processingAttemptCount: 0,
  derivedOrganizationId: null,
}));

/** The tx the platform runner hands the service: `select().from(table).orderBy(...)` resolves the rows. */
const tx = {
  select: () => ({ from: () => ({ orderBy: async () => ROWS }) }),
} as unknown as DbClient;

describe("M35 listRecentWebhooks pages a text-id list", () => {
  const service = buildDrizzleM35RouteService({} as DbClient, {
    platformRunner: async (fn) => fn(tx),
  });

  it("serves every event exactly once across pages, and page 2 is NOT a 422", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await service.listRecentWebhooks(cursor, 2);
      seen.push(...page.items.map((i) => i.stripeEventId));
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(ROWS.map((r) => r.id));
  });

  it("still refuses a cursor that is not one this list minted", async () => {
    await expect(service.listRecentWebhooks("not-a-cursor", 2)).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_CURSOR",
    });
  });
});
