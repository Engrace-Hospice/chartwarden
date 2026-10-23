import { describe, expect, it } from "vitest";
import { type RawGroupRow, applyCohortFloor } from "./cohort-floor";

/** A group made of `n` distinct people named `${prefix}1..n` (so two groups with the same prefix share people). */
const people = (prefix: string, n: number): readonly string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const row = (
  group: string,
  members: readonly string[],
  requests = members.length * 2,
): RawGroupRow => ({
  group,
  members,
  requests,
  acknowledged: requests,
  ackedBeforeDeadlineRate: 1,
  escalationRate: 0,
  medianAckSeconds: 60,
});

describe("applyCohortFloor", () => {
  it("shows every group when each has the minimum number of people", () => {
    const out = applyCohortFloor([row("rn", people("a", 5)), row("md", people("b", 9))], 5);
    expect(out.cells.map((c) => c.group)).toEqual(["rn", "md"]);
    expect(out.suppressedGroups).toBe(0);
    expect(out.withheld).toBe(false);
  });

  it("never exposes the member ids or a people count", () => {
    const out = applyCohortFloor(
      [row("rn", people("a", 8)), row("sw", people("s", 2)), row("ch", people("c", 4))],
      5,
    );
    expect(JSON.stringify(out)).not.toMatch(/members|people|"a1"/);
  });

  it("hides the smallest visible group when one group is hidden (the residual of one small group is under the floor)", () => {
    const out = applyCohortFloor(
      [row("rn", people("a", 9), 40), row("md", people("b", 6), 12), row("sw", people("s", 2))],
      5,
    );
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("two hidden groups whose COMBINED people are under the floor also pull in the next-smallest visible group", () => {
    // sw 2 + ch 1 = 3 distinct people < 5 -> md (smallest visible) is hidden too; residual 3 + 6 = 9 >= 5.
    const out = applyCohortFloor(
      [
        row("rn", people("a", 9), 40),
        row("md", people("b", 6), 12),
        row("sw", people("s", 2)),
        row("ch", people("c", 1)),
      ],
      5,
    );
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(3);
    expect(out.withheld).toBe(false);
  });

  it("two hidden groups whose combined distinct people reach the floor need no extra withholding", () => {
    // sw 3 + ch 3 = 6 distinct people >= 5.
    const out = applyCohortFloor(
      [
        row("rn", people("a", 9)),
        row("md", people("b", 6)),
        row("sw", people("s", 3)),
        row("ch", people("c", 3)),
      ],
      5,
    );
    expect(out.cells.map((c) => c.group)).toEqual(["rn", "md"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("counts the same person in several hidden groups once (per-group counts must not be added)", () => {
    // Both hidden groups are the SAME 3 people: 3 + 3 = 6 would pass a sum, but only 3 distinct people stand behind the residual.
    const out = applyCohortFloor(
      [
        row("rn", people("a", 9), 40),
        row("md", people("b", 6), 12),
        row("sw", people("s", 3)),
        row("ch", people("s", 3)),
      ],
      5,
    );
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(3);
  });

  it("withholds the whole breakdown when even hiding every other group cannot reach the floor", () => {
    const out = applyCohortFloor([row("sw", people("s", 2)), row("ch", people("s", 2))], 5);
    expect(out.cells).toEqual([]);
    expect(out.withheld).toBe(true);
  });

  it("a single small group alone is withheld, not shown", () => {
    const out = applyCohortFloor([row("sw", people("s", 4))], 5);
    expect(out.cells).toEqual([]);
    expect(out.withheld).toBe(true);
  });

  it("counts a threshold of exactly the minimum as visible", () => {
    expect(applyCohortFloor([row("rn", people("a", 5))], 5).cells).toHaveLength(1);
    expect(applyCohortFloor([row("rn", people("a", 4))], 5).cells).toHaveLength(0);
  });
});
