// apps/backend/__tests__/m36-channel-history-cursor.test.ts — the M36 channel-history list refuses a cursor
// the same org validly signed for another list (an M16 mailing-items integer anchor) with 422 INVALID_CURSOR,
// before any read, instead of reaching the `created_at`/`id` comparison and failing the cast as a 500.
import { configureCursorSigningKey, encodeCursor } from "@chartwarden/shared/route-kit";
import { describe, expect, it } from "vitest";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";

const ORG = "00000000-0000-4000-8000-000000000036";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const ROW = "00000000-0000-4000-8000-0000000000e1";

// Any db access throws, so the assertion proves the cursor is refused before the query runs.
const UNTOUCHABLE_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("the db must not be reached");
    },
  },
);

describe("M36 channel history — cross-list cursor replay", () => {
  it("is 422 INVALID_CURSOR for a validly signed cursor with the wrong anchor kind", async () => {
    configureCursorSigningKey("k".repeat(32));
    const svc = createDbMessagingRouteService(UNTOUCHABLE_DB as never);
    const replayed = encodeCursor(ORG, { a: "5", id: ROW });
    await expect(
      svc.listMessages(ORG, { channelId: CHANNEL, userId: "rn_1", cursor: replayed }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", statusCode: 422 });
  });

  it("is 422 INVALID_CURSOR for a non-uuid tie-breaker id", async () => {
    const svc = createDbMessagingRouteService(UNTOUCHABLE_DB as never);
    const replayed = encodeCursor(ORG, { a: "2026-11-06 10:00:00.123456+00", id: "r1" });
    await expect(
      svc.listMessages(ORG, { channelId: CHANNEL, userId: "rn_1", cursor: replayed }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", statusCode: 422 });
  });
});
