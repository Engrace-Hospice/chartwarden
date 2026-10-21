// The two-tier RHC carry-over CHAIN core shared by @chartwarden/billing's `computeRhcCarryOver` (M23, the main path)
// and M6's `rhcCarryOver` fallback: clip to the day before the new election, merge overlapping / touching spans
// into blocks (a day counts once), walk back while each gap is ≤ 60 days, stop at the 60-day high tier.
import { describe, expect, it } from "vitest";
import {
  RHC_CARRY_OVER_MAX_GAP_DAYS,
  RHC_HIGH_TIER_LAST_DAY,
  clipToBeforeElection,
  isoDateToEpochDay,
  mergeCarryBlocks,
  walkCarryChain,
} from "../src/rhc/carry-chain";

const d = (iso: string): number => {
  const day = isoDateToEpochDay(iso);
  if (day === null) throw new Error(`bad test date ${iso}`);
  return day;
};
const span = (start: string, end: string, tag = "x") => ({ start: d(start), end: d(end), tag });

describe("isoDateToEpochDay", () => {
  it("maps a strict YYYY-MM-DD to the UTC epoch day", () => {
    expect(d("1970-01-01")).toBe(0);
    expect(d("2026-03-01") - d("2026-01-31")).toBe(29);
  });

  it("returns null for anything that is not a real calendar date", () => {
    expect(isoDateToEpochDay("2026-02-30")).toBeNull();
    expect(isoDateToEpochDay("2026-3-1")).toBeNull();
    expect(isoDateToEpochDay(null)).toBeNull();
  });
});

describe("clipToBeforeElection", () => {
  it("clips a span reaching the election to the day before it (the hand-off day is day 1 of the new stay)", () => {
    const [clipped] = clipToBeforeElection([span("2026-01-01", "2026-03-01")], d("2026-03-01"));
    expect(clipped?.end).toBe(d("2026-02-28"));
    expect(clipped?.tag).toBe("x");
  });

  it("drops a span starting on or after the election (not prior care)", () => {
    expect(clipToBeforeElection([span("2026-03-01", "2026-03-05")], d("2026-03-01"))).toEqual([]);
  });
});

describe("mergeCarryBlocks", () => {
  it("merges overlapping and next-day spans into one block, keeping every member", () => {
    const blocks = mergeCarryBlocks([
      span("2026-02-01", "2026-02-10", "b"),
      span("2026-01-01", "2026-02-01", "a"), // shares 02-01 with b
      span("2026-02-11", "2026-02-20", "c"), // next day: continuous
      span("2026-04-01", "2026-04-02", "d"),
    ]);
    expect(blocks.map((b) => [b.start, b.end, b.members.map((m) => m.tag)])).toEqual([
      [d("2026-01-01"), d("2026-02-20"), ["a", "b", "c"]],
      [d("2026-04-01"), d("2026-04-02"), ["d"]],
    ]);
  });
});

describe("walkCarryChain", () => {
  it("sums blocks walking back while each gap is ≤ 60 days, counting an overlapped day once", () => {
    const election = d("2026-03-20");
    const blocks = mergeCarryBlocks([
      span("2026-03-01", "2026-03-11"), // 11 days
      span("2026-01-01", "2026-01-31"), // 31 days, gap 29 to 03-01
      span("2026-01-20", "2026-01-25"), // inside the previous: adds nothing
    ]);
    const chain = walkCarryChain(blocks, election);
    expect(chain.totalDays).toBe(42);
    expect(chain.blocks).toHaveLength(2);
    expect(chain.reachedOldest).toBe(true);
    expect(chain.latestEnd).toBe(d("2026-03-11"));
  });

  it("stops at the first gap over 60 days (the window reset)", () => {
    const election = d("2026-04-02"); // 61 days after 01-31
    const chain = walkCarryChain(mergeCarryBlocks([span("2026-01-01", "2026-01-31")]), election);
    expect(RHC_CARRY_OVER_MAX_GAP_DAYS).toBe(60);
    expect(chain.totalDays).toBe(0);
    expect(chain.blocks).toEqual([]);
    expect(chain.reachedOldest).toBe(false);
    expect(chain.latestEnd).toBe(d("2026-01-31"));
  });

  it("carries a gap of exactly 60 days", () => {
    const chain = walkCarryChain(
      mergeCarryBlocks([span("2026-01-01", "2026-01-31")]),
      d("2026-04-01"),
    );
    expect(chain.totalDays).toBe(31);
  });

  it("stops walking once the 60-day high tier is used up", () => {
    const blocks = mergeCarryBlocks([
      span("2026-01-01", "2026-03-31"), // 90 days
      span("2025-12-01", "2025-12-05"),
    ]);
    const chain = walkCarryChain(blocks, d("2026-04-10"));
    expect(RHC_HIGH_TIER_LAST_DAY).toBe(60);
    expect(chain.totalDays).toBe(90);
    expect(chain.blocks).toHaveLength(1);
    expect(chain.reachedOldest).toBe(false);
  });

  it("is empty with no prior care", () => {
    expect(walkCarryChain([], d("2026-04-10"))).toEqual({
      blocks: [],
      totalDays: 0,
      reachedOldest: true,
      latestEnd: null,
    });
  });
});
