// ADR-0113 — the one instant format every closure surface shares.
import { describe, expect, it } from "vitest";
import { formatClosureInstant } from "./closure-instant";

describe("formatClosureInstant", () => {
  it("shows a dash for an unparseable instant, never 'Invalid Date'", () => {
    expect(formatClosureInstant("not a date")).toBe("—");
    expect(formatClosureInstant("")).toBe("—");
  });

  it("prints a real instant as a date and time (the viewer's locale and zone decide the exact words)", () => {
    const text = formatClosureInstant("2026-11-18T15:40:00.000Z");
    expect(text).not.toBe("—");
    expect(text).toMatch(/\d/);
  });
});
