import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("M23 MAC jurisdiction database contract", () => {
  it("reuses the foundation migration's canonical enum in SQL and Drizzle", () => {
    expect(read("packages/db/migrations/0074_billing_m23_enums_claim.sql")).toContain(
      'CREATE TYPE "public"."mac_jurisdiction"',
    );

    for (const path of [
      "packages/db/migrations/1489_m23_medicare_provider_routing.sql",
      "packages/db/migrations/1490_m23_claimmd_medicare_routing.sql",
    ]) {
      const migration = read(path);
      expect(migration).toMatch(/mac_jurisdiction mac_jurisdiction NOT NULL/);
      expect(migration).not.toContain("m23_mac_jurisdiction");
    }

    const billingTypes = read("packages/db/src/schema/billing/types.ts");
    expect(billingTypes).toContain('m23MacJurisdiction = pgEnum("mac_jurisdiction"');
    expect(billingTypes).not.toContain('pgEnum("m23_mac_jurisdiction"');
  });
});
