import { describe, expect, it } from "vitest";
import { pointInRings, ringsAreValid } from "./point-in-rings";

const SQUARE = [
  [
    [-123, 45],
    [-122, 45],
    [-122, 46],
    [-123, 46],
    [-123, 45],
  ],
] as const;
const HOLE = [
  [-122.6, 45.4],
  [-122.4, 45.4],
  [-122.4, 45.6],
  [-122.6, 45.6],
  [-122.6, 45.4],
] as const;

describe("pointInRings", () => {
  it("is true inside the outer ring and false outside", () => {
    expect(pointInRings(SQUARE, { latitude: 45.5, longitude: -122.5 })).toBe(true);
    expect(pointInRings(SQUARE, { latitude: 47, longitude: -122.5 })).toBe(false);
  });

  it("treats a second ring as a hole", () => {
    const withHole = [SQUARE[0], HOLE] as const;
    expect(pointInRings(withHole, { latitude: 45.5, longitude: -122.5 })).toBe(false);
    expect(pointInRings(withHole, { latitude: 45.1, longitude: -122.9 })).toBe(true);
  });

  it("matches nothing for a degenerate ring instead of throwing", () => {
    expect(
      pointInRings(
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        { latitude: 0.5, longitude: 0.5 },
      ),
    ).toBe(false);
  });
});

describe("ringsAreValid", () => {
  it("accepts a closed ring in range", () => {
    expect(ringsAreValid(SQUARE)).toBe(true);
  });

  it("rejects empty, open, short and out-of-range rings", () => {
    expect(ringsAreValid([])).toBe(false);
    expect(
      ringsAreValid([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ]),
    ).toBe(false); // not closed
    expect(
      ringsAreValid([
        [
          [0, 0],
          [1, 1],
          [0, 0],
        ],
      ]),
    ).toBe(false); // < 4 points
    expect(
      ringsAreValid([
        [
          [0, 0],
          [200, 0],
          [200, 1],
          [0, 0],
        ],
      ]),
    ).toBe(false); // lng out of range
  });
});
