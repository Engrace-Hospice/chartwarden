import { describe, expect, it } from "vitest";
import { productionDay } from "../service-drizzle";

describe("835 production date", () => {
  it("keeps the printed calendar day whatever time or offset the clearinghouse appends", () => {
    expect(productionDay("2026-06-15").toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(productionDay("2026-06-15T00:00:00Z").toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(productionDay("2026-06-15T23:30:00-05:00").toISOString()).toBe(
      "2026-06-15T00:00:00.000Z",
    );
  });
});
