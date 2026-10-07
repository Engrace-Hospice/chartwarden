/**
 * GAP-087 — R-14 must not return a fabricated "queued" export job. No export pipeline (job table, bound vendor
 * adapters / caregiver-contact cipher / outbox) exists, so the route service refuses 501 and never touches the DB.
 */
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import type { M30WriteActor } from "../src/modules/30-quality/routes/actor";
import { buildDrizzleM30WriteService } from "../src/modules/30-quality/routes/write-service-drizzle";

const UNTOUCHED_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("a refused CAHPS export must not touch the database");
    },
  },
) as DbClient;

describe("M30 R-14 createCahpsExport (GAP-087)", () => {
  it("refuses 501 instead of returning a random exportId with status queued", async () => {
    const service = buildDrizzleM30WriteService(UNTOUCHED_DB);
    await expect(
      service.createCahpsExport({ organizationId: "org-1", userId: "user-1" } as M30WriteActor, {
        samplePeriodStart: "2026-09-01T00:00:00.000Z",
        samplePeriodEnd: "2026-09-30T23:59:59.000Z",
      }),
    ).rejects.toMatchObject({ code: "CAHPS_EXPORT_NOT_IMPLEMENTED", statusCode: 501 });
  });
});
