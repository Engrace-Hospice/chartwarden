import { describe, expect, it } from "vitest";
import {
  M11_STANDING_SPAWN_QUEUE,
  M11_STANDING_SPAWN_SCHEDULE,
  runStandingSpawnFanout,
} from "../src/modules/11-orders/jobs";

describe("M11 D5 standing-spawn worker", () => {
  it("uses the authoritative hourly queue contract", () => {
    expect(M11_STANDING_SPAWN_QUEUE).toBe("orders.standing_spawn");
    expect(M11_STANDING_SPAWN_SCHEDULE).toBe("0 * * * *");
  });
  it("fans out active org ids and isolates an org failure", async () => {
    const seen: string[] = [];
    await expect(
      runStandingSpawnFanout({
        connection: {} as never,
        activeOrgs: {
          async listActiveOrgs() {
            return [{ organizationId: "org-a" }, { organizationId: "org-b" }];
          },
        },
        service: {
          async spawnDueStandingOrders(org: string) {
            seen.push(org);
            if (org === "org-a") throw new Error("legacy attribution");
            return { spawnedOrderIds: [] };
          },
        } as never,
      }),
    ).rejects.toThrow("M11_STANDING_SPAWN");
    expect(seen).toEqual(["org-a", "org-b"]);
  });
});
