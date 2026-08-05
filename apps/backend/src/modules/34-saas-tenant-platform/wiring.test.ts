import { describe, expect, it } from "vitest";
import { buildPlatformEnqueue, buildTenantEnqueue } from "./wiring";

describe("M34 production queue containment", () => {
  it("refuses platform jobs while required worker ports are unbound", async () => {
    await expect(
      buildPlatformEnqueue(undefined).enqueue.enqueue("tenant.provision", "tenant-1", {
        tenantAccountId: "tenant-1",
      }),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });

  it("refuses tenant jobs while required worker ports are unbound", async () => {
    await expect(
      buildTenantEnqueue(undefined).enqueue.enqueue("tenant.dsar_export", { jobId: "dsar-1" }),
    ).rejects.toMatchObject({ code: "DEGRADED", statusCode: 503 });
  });
});
