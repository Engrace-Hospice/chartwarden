import { describe, expect, it } from "vitest";
import { type RawGroupRow, applyCohortFloor } from "./cohort-floor";

const row = (group: string, people: number, requests = people * 2): RawGroupRow => ({
  group,
  people,
  requests,
  acknowledged: requests,
  ackedBeforeDeadlineRate: 1,
  escalationRate: 0,
  medianAckSeconds: 60,
});

describe("applyCohortFloor", () => {
  it("shows every group when each has the minimum number of people", () => {
    const out = applyCohortFloor([row("rn", 5), row("md", 9)], 5);
    expect(out.cells.map((c) => c.group)).toEqual(["rn", "md"]);
    expect(out.suppressedGroups).toBe(0);
  });

  it("hides groups below the minimum and never exposes the people count", () => {
    const out = applyCohortFloor([row("rn", 8), row("sw", 2), row("chaplain", 1)], 5);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(2);
    expect(JSON.stringify(out)).not.toContain("people");
  });

  it("hides the smallest visible group when exactly one would otherwise be hidden (no differencing)", () => {
    const out = applyCohortFloor([row("rn", 9, 40), row("md", 6, 12), row("sw", 2)], 5);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("returns nothing visible and counts the hidden group when only one group exists and it is small", () => {
    const out = applyCohortFloor([row("sw", 4)], 5);
    expect(out.cells).toEqual([]);
    expect(out.suppressedGroups).toBe(1);
  });

  it("counts a threshold of exactly the minimum as visible", () => {
    expect(applyCohortFloor([row("rn", 5)], 5).cells).toHaveLength(1);
    expect(applyCohortFloor([row("rn", 4)], 5).cells).toHaveLength(0);
  });
});
