import { describe, expect, it } from "vitest";
import { DEADLINE_SWEEP_LOOKBACK_HOURS, deadlineLookbackFloor } from "../jobs/deadline-sweeps";

describe("deadlineLookbackFloor", () => {
  it("returns now minus the bounded catch-up lookback", () => {
    const now = new Date("2026-09-10T15:00:00.000Z");
    const floor = deadlineLookbackFloor(now);
    expect(now.getTime() - floor.getTime()).toBe(DEADLINE_SWEEP_LOOKBACK_HOURS * 3_600_000);
    expect(floor.toISOString()).toBe("2026-09-08T15:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const now = new Date("2026-09-10T15:00:00.000Z");
    deadlineLookbackFloor(now);
    expect(now.toISOString()).toBe("2026-09-10T15:00:00.000Z");
  });
});
