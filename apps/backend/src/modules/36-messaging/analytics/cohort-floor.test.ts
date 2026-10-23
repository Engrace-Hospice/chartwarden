import { describe, expect, it } from "vitest";
import { type RawGroupRow, applyCohortFloor, clearsFloor } from "./cohort-floor";

/** A group made of `n` distinct people named `${prefix}1..n` (so two groups with the same prefix share people). */
const people = (prefix: string, n: number): readonly string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** `members` holds one id per request (round-robin over the people), as the reader returns it; default 10 requests per person. */
const row = (group: string, who: readonly string[], requests = who.length * 10): RawGroupRow => ({
  group,
  members: Array.from({ length: requests }, (_, i) => who[i % who.length] as string),
  requests,
  acknowledged: requests,
  ackedBeforeDeadlineRate: 1,
  escalationRate: 0,
  medianAckSeconds: 60,
});

const LIMITS = { minCohort: 5, minRequests: 20, maxPersonShare: 0.8 };
const floor = (rows: readonly RawGroupRow[]) => applyCohortFloor(rows, LIMITS);

describe("applyCohortFloor", () => {
  it("shows every group when each has the minimum number of people", () => {
    const out = floor([row("rn", people("a", 5)), row("md", people("b", 9))]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn", "md"]);
    expect(out.suppressedGroups).toBe(0);
    expect(out.withheld).toBe(false);
  });

  it("never exposes the member ids or a people count", () => {
    const out = floor([
      row("rn", people("a", 8)),
      row("sw", people("s", 2)),
      row("ch", people("c", 4)),
    ]);
    expect(JSON.stringify(out)).not.toMatch(/members|people|"a1"/);
  });

  it("hides the smallest visible group when one group is hidden (the residual of one small group is under the floor)", () => {
    const out = floor([
      row("rn", people("a", 9), 40),
      row("md", people("b", 6), 30),
      row("sw", people("s", 2)),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("two hidden groups whose COMBINED people are under the floor also pull in the next-smallest visible group", () => {
    // sw 2 + ch 1 = 3 distinct people < 5 -> md (smallest visible) is hidden too; residual 3 + 6 = 9 >= 5.
    const out = floor([
      row("rn", people("a", 9), 40),
      row("md", people("b", 6), 30),
      row("sw", people("s", 2)),
      row("ch", people("c", 1)),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(3);
    expect(out.withheld).toBe(false);
  });

  it("two hidden groups whose combined distinct people reach the floor need no extra withholding", () => {
    // sw 3 + ch 3 = 6 distinct people >= 5.
    const out = floor([
      row("rn", people("a", 9)),
      row("md", people("b", 6)),
      row("sw", people("s", 3)),
      row("ch", people("c", 3)),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn", "md"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("counts the same person in several hidden groups once (per-group counts must not be added)", () => {
    // Both hidden groups are the SAME 3 people: 3 + 3 = 6 would pass a sum, but only 3 distinct people stand behind the residual.
    const out = floor([
      row("rn", people("a", 9), 40),
      row("md", people("b", 6), 30),
      row("sw", people("s", 3)),
      row("ch", people("s", 3)),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(3);
  });

  it("withholds the whole breakdown when even hiding every other group cannot reach the floor", () => {
    const out = floor([row("sw", people("s", 2)), row("ch", people("s", 2))]);
    expect(out.cells).toEqual([]);
    expect(out.withheld).toBe(true);
  });

  it("a single small group alone is withheld, not shown", () => {
    const out = floor([row("sw", people("s", 4))]);
    expect(out.cells).toEqual([]);
    expect(out.withheld).toBe(true);
  });

  it("hides a group with enough people but too few requests", () => {
    const out = floor([
      row("rn", people("a", 9)),
      row("md", people("b", 5), 19),
      row("sw", people("s", 5), 10),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("applies the request floor to the combined hidden residual too (people alone are not enough)", () => {
    // sw 6 people / 6 requests is hidden (too few requests): the residual has 6 people but only 6 requests < 20 -> md is pulled in.
    const out = floor([
      row("rn", people("a", 9)),
      row("md", people("b", 6), 30),
      row("sw", people("s", 6), 6),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(2);
  });

  it("withholds a cell where one person owns more than 80 percent of the requests", () => {
    const dominated: RawGroupRow = {
      ...row("md", people("b", 6), 30),
      members: [...Array.from({ length: 25 }, () => "b1"), ...people("b", 6).slice(1)],
    };
    const out = floor([row("rn", people("a", 9)), dominated, row("sw", people("s", 6))]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    // the dominated cell is itself the residual, so it fails the share rule and the smallest visible group joins it
    expect(out.suppressedGroups).toBe(2);
  });

  it("applies the one-person share rule to the merged hidden residual", () => {
    // sw (6 people, 30 requests) is hidden by dominance of s1; ch (6 people, 30 requests) is hidden by dominance of s1 too. The residual
    // is 60 requests of which s1 owns 50: it fails the share rule, so md is pulled in (md has 30 requests, spread).
    const dom = (g: string, tag: string): RawGroupRow => ({
      ...row(g, people(tag, 6), 30),
      members: [...Array.from({ length: 25 }, () => `${tag}1`), ...people(tag, 6).slice(1)],
    });
    const same = (g: string): RawGroupRow => ({ ...dom(g, "s") });
    const out = floor([
      row("rn", people("a", 9)),
      row("md", people("b", 6), 30),
      same("sw"),
      same("ch"),
    ]);
    expect(out.cells.map((c) => c.group)).toEqual(["rn"]);
    expect(out.suppressedGroups).toBe(3);
  });

  it("clearsFloor rejects a total dominated by one person", () => {
    const total = {
      ...row("all", people("a", 6), 30),
      members: [...Array.from({ length: 25 }, () => "a1"), ...people("a", 6).slice(1)],
    };
    expect(clearsFloor(total, LIMITS)).toBe(false);
    expect(clearsFloor(row("all", people("a", 6), 30), LIMITS)).toBe(true);
  });

  it("counts a threshold of exactly the minimum as visible", () => {
    expect(floor([row("rn", people("a", 5))]).cells).toHaveLength(1);
    expect(floor([row("rn", people("a", 4))]).cells).toHaveLength(0);
  });
});
