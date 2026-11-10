// Step 10 holds three lines so the DoseSpot branch merges later without rework: no call to that branch's tenant routes, no check of its
// permission keys, no assumption about how step 10 settles. A panel that names any of them is a panel that depends on a branch not in
// this tree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("./dosespot-panel.tsx", import.meta.url), "utf8");

describe("dosespot-panel source", () => {
  it.each([
    ["a tenant DoseSpot route", /\/api\/v1\/tenant\/dosespot/],
    ["a clinic registration key", /prescribing\.clinic/],
    ["a tenant DoseSpot key", /tenant_dosespot/],
    ["an API client", /useApiClient|client\.(GET|POST|PUT|PATCH|DELETE)/],
    ["a settled-by-fact assumption", /dosespotSettled|dosespotKickoffRecorded/],
  ])("does not reference %s", (_label, pattern) => {
    expect(pattern.test(SOURCE)).toBe(false);
  });
});
