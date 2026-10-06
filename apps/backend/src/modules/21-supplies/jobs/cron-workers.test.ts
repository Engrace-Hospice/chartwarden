import { describe, expect, it } from "vitest";
import { localHourIn } from "./cron-workers";

describe("localHourIn", () => {
  const at = new Date("2026-10-05T04:30:00.000Z");

  it("reads the wall-clock hour in the Location's zone", () => {
    expect(localHourIn(at, "UTC")).toBe(4);
    expect(localHourIn(at, "America/Los_Angeles")).toBe(21);
  });

  it("falls back to UTC for an unusable zone rather than throwing", () => {
    expect(localHourIn(at, "Not/AZone")).toBe(4);
  });
});
