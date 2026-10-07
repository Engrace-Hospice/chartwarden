// @wardenx/billing — the RHC carry-over is bounded against an external (HETS) answer: interval attribution equals
// the per-day reference walk, and a hostile 271 (absurd dates, too many rows) is cheap, warned and bounded.
import { type RhcHetsPeriod, computeRhcCarryOver } from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import { attributeOwnedDays } from "../src/hipps/rhc-carry-over";

/** The original per-day walk: each day to the first ranked member covering it. Reference only (small inputs). */
function perDayReference(
  members: readonly { start: number; end: number; priority: number }[],
): number[] {
  const owner = new Map<number, number>();
  const ranked = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.priority - b.m.priority || a.m.start - b.m.start);
  for (const { m, i } of ranked) {
    for (let d = m.start; d <= m.end; d++) if (!owner.has(d)) owner.set(d, i);
  }
  return members.map((_, i) => [...owner.values()].filter((o) => o === i).length);
}

/** Deterministic PRNG (mulberry32) so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("attributeOwnedDays ≡ the per-day reference walk", () => {
  it("agrees on 2,000 random small inputs (overlaps, ties, touching ranges, priorities)", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 8);
      const members = Array.from({ length: n }, () => {
        const start = Math.floor(r() * 40);
        return {
          start,
          end: start + Math.floor(r() * 15),
          priority: Math.floor(r() * 3),
        };
      });
      expect(attributeOwnedDays(members), `seed ${seed}`).toEqual(perDayReference(members));
    }
  });

  it("is independent of span length (a 3-million-day range is one interval)", () => {
    const counted = attributeOwnedDays([
      { start: -2_000_000, end: 1_000_000, priority: 1 },
      { start: 0, end: 9, priority: 0 },
    ]);
    expect(counted).toEqual([3_000_001 - 10, 10]);
  });
});

describe("computeRhcCarryOver — a hostile / malformed HETS answer", () => {
  const ELECTION = "2026-02-16";
  const extreme = (i: number): RhcHetsPeriod => ({
    kind: i % 2 === 0 ? "benefit_period" : "election",
    startDate: "1900-01-01",
    endDate: i % 2 === 0 ? "9999-12-31" : null,
    hospiceNpi: "1649726464",
    daysUsed: 3_000_000,
  });

  it("360 rows spanning 1900-01-01 … 9999-12-31 complete fast and are ignored with a warning", () => {
    const t0 = performance.now();
    const r = computeRhcCarryOver({
      electionDate: ELECTION,
      internalStays: [],
      hets: {
        stale: false,
        truncated: true,
        periods: Array.from({ length: 360 }, (_, i) => extreme(i)),
      },
    });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(r.priorDays).toBe(0);
    expect(r.chain).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("hets_row_ignored");
  });

  it("an in-range start with an absurd end is clipped before the election, counted once, and warned", () => {
    const t0 = performance.now();
    const periods: RhcHetsPeriod[] = Array.from({ length: 360 }, () => ({
      kind: "benefit_period",
      startDate: "1966-01-01",
      endDate: "9999-12-31",
      hospiceNpi: "1649726464",
      daysUsed: null,
    }));
    const r = computeRhcCarryOver({
      electionDate: ELECTION,
      internalStays: [],
      hets: { stale: false, truncated: false, periods },
    });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.priorDays).toBe(60);
    // The 360 identical rows are one block whose days go to one row (never 360 × counted).
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0]).toMatchObject({ start: "1966-01-01", end: "2026-02-15", endAssumed: true });
    // Bounded: the counted chain covers 1966-01-01 … 2026-02-15 at most, never the year 9999.
    expect(r.chain.every((s) => s.end <= "2026-02-15")).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("hets_end_ignored");
  });

  it("more rows than the HETS maximum: the 360 most recent are counted, with a warning", () => {
    const periods: RhcHetsPeriod[] = Array.from({ length: 5_000 }, (_, i) => ({
      kind: "election",
      startDate: `20${String(10 + (i % 15)).padStart(2, "0")}-01-01`,
      endDate: null,
      hospiceNpi: null,
    }));
    const t0 = performance.now();
    const r = computeRhcCarryOver({
      electionDate: ELECTION,
      internalStays: [],
      hets: { stale: false, truncated: true, periods },
    });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(r.warnings.map((w) => w.code)).toContain("hets_rows_capped");
    expect(r.priorDays).toBeLessThanOrEqual(60);
  });

  it("unparseable dates never throw or yield NaN; a non-integer days-used is ignored", () => {
    const r = computeRhcCarryOver({
      electionDate: ELECTION,
      internalStays: [{ start: "not-a-date" as never, end: null }],
      hets: {
        stale: false,
        truncated: false,
        periods: [
          { kind: "benefit_period", startDate: "2026-02-30", endDate: null, hospiceNpi: null },
          {
            kind: "benefit_period",
            startDate: "2026-01-01",
            endDate: "garbage" as never,
            hospiceNpi: null,
            daysUsed: 2.5,
          },
        ],
      },
    });
    expect(Number.isFinite(r.priorDays)).toBe(true);
    expect(Number.isFinite(r.chainDays)).toBe(true);
    // 2026-01-01 with no usable end: assumed to run to the day before the election (46 days).
    expect(r.chainDays).toBe(46);
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        "hets_row_ignored",
        "hets_end_ignored",
        "open_span_assumed_continuous",
      ]),
    );
  });
});
