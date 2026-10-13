import { afterEach, describe, expect, it } from "vitest";
import { NO_FILTERS, queryFor } from "./use-message-search";

describe("queryFor", () => {
  const originalZone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalZone;
  });

  it("ends a 'Before' window at the start of the next calendar day, also on a 25-hour DST day", () => {
    process.env.TZ = "America/Chicago"; // 2026-11-01: clocks go back, the day has 25 hours
    const { to } = queryFor("x", { ...NO_FILTERS, before: "2026-11-01" }) as { to: string };
    expect(to).toBe(new Date(2026, 10, 2).toISOString());
  });
});
