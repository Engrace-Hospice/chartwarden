// The platform DSAR list pages in SQL and casts its cursor to timestamptz and uuid: a cursor that decodes (valid base64url JSON) but is
// neither used to reach the database and fail there as a 500. It is a 400 now, judged before the platform context is even entered.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { encodeCursor } from "../routes/platform/concurrency";
import { createDrizzlePlatformOpsService } from "../routes/platform/ops-service";

describe("the platform DSAR list's cursor", () => {
  const untouched = {
    transaction: () => {
      throw new Error("the database must not be reached for a malformed cursor");
    },
  } as unknown as DbClient;
  const ops = createDrizzlePlatformOpsService({
    platformDb: untouched,
    auditBypass: async () => {
      throw new Error("no platform bypass may be entered for a malformed cursor");
    },
    platformJobId: "ops-cursor-test",
  });

  it("answers 400 for a cursor whose timestamp or id would fail the database's cast, reaching neither the platform context nor the database", async () => {
    for (const cursor of [
      encodeCursor({ createdAt: "garbage", id: "6f1f9c3e-8d2a-4b7e-9a10-2c4d5e6f7a8b" }),
      encodeCursor({ createdAt: "2026-11-06T12:00:00Z", id: "not-a-uuid" }),
      encodeCursor({
        createdAt: "2026-02-31T00:00:00Z",
        id: "6f1f9c3e-8d2a-4b7e-9a10-2c4d5e6f7a8b",
      }),
      "%%%",
    ]) {
      await expect(ops.listDsarJobs({}, cursor, 10), cursor).rejects.toMatchObject({
        statusCode: 400,
        code: "VALIDATION_FAILED",
      });
    }
  });
});
