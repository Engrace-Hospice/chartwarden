import { describe, expect, it } from "vitest";
import { INTAKE_OPERATIONAL_LIVE_SUITES } from "../test-intake-operational-live";

describe("intake operational live-suite runner", () => {
  it("allowlists every F235-F238 PostgreSQL suite and nothing broader", () => {
    expect(INTAKE_OPERATIONAL_LIVE_SUITES).toEqual([
      "apps/backend/__tests__/f235-doclens-m5-writeback.live.test.ts",
      "apps/backend/__tests__/f236-doclens-intake.live.test.ts",
      "apps/backend/__tests__/f237-doclens-review.live.test.ts",
      "apps/backend/__tests__/f238-doclens-dx-writeback.live.test.ts",
      "apps/backend/__tests__/f238-doclens-clinical-writeback.live.test.ts",
      "apps/backend/__tests__/f238-doclens-identity-relink.live.test.ts",
      "apps/backend/__tests__/f238-records-request.live.test.ts",
    ]);
    expect(INTAKE_OPERATIONAL_LIVE_SUITES.every((suite) => suite.endsWith(".live.test.ts"))).toBe(
      true,
    );
  });
});
