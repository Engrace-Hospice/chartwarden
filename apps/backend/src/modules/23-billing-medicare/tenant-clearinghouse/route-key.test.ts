import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import type { ConfigRow } from "./config-store";
import { buildOrgRouteKeyReader } from "./route-key";

const ORG = "11111111-1111-4111-8111-111111111111";

/** A transaction whose `select().from().where().limit()` yields `row` (the one query the config store runs). */
const txReturning = (row: Partial<ConfigRow> | null): DbClient =>
  ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
  }) as unknown as DbClient;

describe("organization EDI route key", () => {
  const lookup = (org: string) => (org === ORG ? ({ vendor: "stedi", mode: "test" } as const) : null);
  const reader = buildOrgRouteKeyReader(lookup);

  it("is the vendor of the org's own active config", async () => {
    expect(await reader(txReturning({ vendor: "claimmd", status: "active" }), ORG)).toBe("claimmd");
  });

  it("is null for outside, and for a config that is not live yet", async () => {
    expect(await reader(txReturning({ vendor: "outside", status: "active" }), ORG)).toBeNull();
    expect(await reader(txReturning({ vendor: "stedi", status: "verified" }), ORG)).toBeNull();
  });

  it("is the platform env vendor for an org named in the fallback list that has no row, else null", async () => {
    expect(await reader(txReturning(null), ORG)).toBe("stedi");
    expect(await reader(txReturning(null), "22222222-2222-4222-8222-222222222222")).toBeNull();
  });
});
