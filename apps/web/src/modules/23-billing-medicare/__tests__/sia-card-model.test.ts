import { describe, expect, it } from "vitest";
import { type SiaVisit, minutesCellText, minutesLabel } from "../sia-card-model";

describe("minutesCellText", () => {
  const visit = (over: Partial<SiaVisit>): SiaVisit => ({
    id: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-28",
    discipline: "rn",
    minutes: 75,
    timeSource: null,
    units: 5,
    paidUnits: 5,
    counted: true,
    reason: null,
    ...over,
  });

  it("marks where the minutes came from, so typed times are visible to a reviewer", () => {
    expect(minutesCellText(visit({ timeSource: "clinician" }))).toBe("75 (typed)");
    expect(minutesCellText(visit({ timeSource: "evv", minutes: 12.5 }))).toBe("12.5 (EVV)");
  });

  it("leaves minutes unmarked when no source was recorded (an older revision), and shows no time as a dash", () => {
    expect(minutesCellText(visit({ timeSource: null }))).toBe("75");
    expect(minutesCellText(visit({ minutes: null, timeSource: "clinician" }))).toBe("—");
  });
});

describe("minutesLabel", () => {
  it("shows whole minutes as they are", () => {
    expect(minutesLabel(75)).toBe("75");
    expect(minutesLabel(0)).toBe("0");
  });

  it("shows a fractional visit (an EVV bracket kept in seconds) to one decimal, truncated", () => {
    expect(minutesLabel(12.5)).toBe("12.5");
    expect(minutesLabel(49.75)).toBe("49.7"); // never rounded up to 49.8
    expect(minutesLabel(12.3333333)).toBe("12.3");
    expect(minutesLabel(12.3)).toBe("12.3"); // float error on an exact tenth does not drop it to 12.2
  });

  it("never shows a unit boundary a visit has not reached: 22 min 28 s is not '22.5'", () => {
    // 22 min 30 s (22.5) is where the visit rounds up to 2 units; 22 min 28 s (22.4667) is short of it.
    expect(minutesLabel(22 + 28 / 60)).toBe("22.4");
    expect(minutesLabel(22.5)).toBe("22.5");
    expect(minutesLabel(22 + 29.999 / 60)).toBe("22.4");
    expect(minutesLabel(7.4999)).toBe("7.4");
  });
});
