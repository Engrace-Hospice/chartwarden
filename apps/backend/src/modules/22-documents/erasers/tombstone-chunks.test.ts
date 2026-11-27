// CW-DS-01 — the tombstone INSERT is sliced so an erase of more than 13,107 versions (5 bound values each, Postgres allows 65,535 per
// statement) does not fail on the bind limit. The real >13,107-row erase runs in apps/backend/__tests__/m22-object-destruction-tombstones.live.test.ts.
import { describe, expect, it } from "vitest";
import { TOMBSTONE_INSERT_CHUNK, inChunks } from "./tombstone-chunks";

const POSTGRES_MAX_BIND_VALUES = 65_535;
const VALUES_PER_TOMBSTONE_ROW = 5;
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("TOMBSTONE_INSERT_CHUNK", () => {
  it("keeps one statement far below the Postgres bind limit", () => {
    expect(TOMBSTONE_INSERT_CHUNK * VALUES_PER_TOMBSTONE_ROW).toBeLessThan(
      POSTGRES_MAX_BIND_VALUES / 10,
    );
  });
});

describe("inChunks", () => {
  it("gives no slice for an empty list", () => {
    expect(inChunks([], 3)).toEqual([]);
  });

  it("splits at the chunk boundary: one short, exactly full, one over, an exact multiple", () => {
    const sizes = (n: number): number[] => inChunks(range(n), 4).map((c) => c.length);
    expect(sizes(1)).toEqual([1]);
    expect(sizes(3)).toEqual([3]);
    expect(sizes(4)).toEqual([4]);
    expect(sizes(5)).toEqual([4, 1]);
    expect(sizes(8)).toEqual([4, 4]);
    expect(sizes(9)).toEqual([4, 4, 1]);
  });

  it("keeps every item once, in order", () => {
    const items = range(2_503);
    const slices = inChunks(items, TOMBSTONE_INSERT_CHUNK);
    expect(slices.map((s) => s.length)).toEqual([1000, 1000, 503]);
    expect(slices.flat()).toEqual(items);
  });

  it("covers a patient past the old single-statement limit (13,107 rows) with no slice near it", () => {
    const rows = Math.floor(POSTGRES_MAX_BIND_VALUES / VALUES_PER_TOMBSTONE_ROW) + 1;
    const slices = inChunks(range(rows), TOMBSTONE_INSERT_CHUNK);
    expect(slices.length).toBe(14);
    for (const slice of slices)
      expect(slice.length * VALUES_PER_TOMBSTONE_ROW).toBeLessThan(POSTGRES_MAX_BIND_VALUES);
    expect(slices.reduce((n, s) => n + s.length, 0)).toBe(rows);
  });

  it("refuses a size that is not a whole number >= 1", () => {
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => inChunks([1], size)).toThrow(/whole size >= 1/);
  });
});
