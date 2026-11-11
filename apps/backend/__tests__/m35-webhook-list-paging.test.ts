/**
 * `GET /api/admin/webhooks/stripe/recent` pages a list whose tie-breaker is `stripe_webhook_event.id`: a TEXT Stripe event id
 * (`evt_...`, mixed case), not a uuid. Every other M35 list pages on a uuid, and the shared page helper checked the cursor's id as a
 * uuid, so page 1 answered and page 2 (the cursor the page itself had just minted) was a 422 INVALID_CURSOR. Inherited from main.
 *
 * Three properties, each falsifiable:
 *  1. the walk across pages serves every event exactly once with real-shaped ids;
 *  2. the SQL orders by (received_at DESC, id DESC): `received_at` alone leaves the tie order undefined, and two events can share a
 *     millisecond (the cursor's anchor is millisecond-truncated while Postgres orders by microseconds);
 *  3. the page boundary does not depend on how the SQL collation orders mixed-case ids against JavaScript's code-unit comparison: the
 *     continuation is the row AFTER the cursor's row, in the order the rows arrived in.
 */
import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildDrizzleM35RouteService } from "../src/modules/35-subscription/routes/service-drizzle";

const SAME_MS = new Date(Date.UTC(2026, 10, 6, 12, 0, 0, 123));
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 6, 12, minute, 0));
const row = (id: string, eventType: string, receivedAt: Date) => ({
  id,
  eventType,
  receivedAt,
  processedAt: null,
  processingAttemptCount: 0,
  derivedOrganizationId: null,
});

/** Newest first, as the service's `ORDER BY received_at DESC, id DESC` hands them over (distinct minutes). */
const DISTINCT = [
  row("evt_1QzXkL2eZvKYlo2C0aaaaaaa", "invoice.paid", at(5)),
  row("evt_1QzXkL2eZvKYlo2C0bbbbbbb", "invoice.created", at(4)),
  row("evt_1QzXkL2eZvKYlo2C0ccccccc", "customer.updated", at(3)),
  row("evt_1QzXkL2eZvKYlo2C0ddddddd", "invoice.paid", at(2)),
  row("evt_1QzXkL2eZvKYlo2C0eeeeeee", "charge.succeeded", at(1)),
];

/**
 * Five events in ONE millisecond, in the order a case-insensitive SQL collation (en_US.utf8) sorts the ids DESC: the order the
 * database hands them over. JavaScript's code-unit comparison (uppercase before lowercase) disagrees with it.
 */
const SAME_MS_ROWS = [
  row("evt_zB", "a", SAME_MS),
  row("evt_Za", "b", SAME_MS),
  row("evt_yC", "c", SAME_MS),
  row("evt_Xd", "d", SAME_MS),
  row("evt_wE", "e", SAME_MS),
];

interface Capture {
  orderBy: string | null;
}
function serviceOver(rows: readonly unknown[], capture: Capture = { orderBy: null }) {
  const tx = {
    select: () => ({
      from: () => ({
        orderBy: async (...columns: Parameters<PgDialect["sqlToQuery"]>[0][]) => {
          const dialect = new PgDialect();
          capture.orderBy = columns.map((c) => dialect.sqlToQuery(c).sql).join(", ");
          return rows;
        },
      }),
    }),
  } as unknown as DbClient;
  return buildDrizzleM35RouteService({} as DbClient, { platformRunner: async (fn) => fn(tx) });
}

async function walk(service: ReturnType<typeof serviceOver>, size: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await service.listRecentWebhooks(cursor, size);
    seen.push(...page.items.map((i) => i.stripeEventId));
    if (!page.hasMore || page.nextCursor === null) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

describe("M35 listRecentWebhooks pages a text-id list", () => {
  it("serves every event exactly once across pages, and page 2 is NOT a 422", async () => {
    expect(await walk(serviceOver(DISTINCT), 2)).toEqual(DISTINCT.map((r) => r.id));
  });

  it("orders by received_at DESC then id DESC (a received_at-only order leaves the tie order undefined)", async () => {
    const capture: Capture = { orderBy: null };
    await serviceOver(DISTINCT, capture).listRecentWebhooks(undefined, 2);
    expect(capture.orderBy).toMatch(/"received_at" desc/i);
    expect(capture.orderBy).toMatch(/"id" desc/i);
    expect(capture.orderBy?.search(/"received_at" desc/i)).toBeLessThan(
      capture.orderBy?.search(/"id" desc/i) ?? -1,
    );
  });

  it.each([1, 2, 3, 4])(
    "five events of one millisecond with mixed-case ids are served once each, in the database's order, with pages of %i",
    async (size) => {
      expect(await walk(serviceOver(SAME_MS_ROWS), size)).toEqual(SAME_MS_ROWS.map((r) => r.id));
    },
  );

  it("still refuses a cursor that is not one this list minted", async () => {
    await expect(serviceOver(DISTINCT).listRecentWebhooks("not-a-cursor", 2)).rejects.toMatchObject(
      {
        statusCode: 422,
        code: "INVALID_CURSOR",
      },
    );
  });
});
