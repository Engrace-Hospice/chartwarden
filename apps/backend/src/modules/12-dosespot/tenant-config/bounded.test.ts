// The roster list resolves each prescriber's physician record through the directory: at most `limit` at a time, results in input order.
import { describe, expect, it } from "vitest";
import { mapBounded } from "./bounded";

describe("mapBounded", () => {
  it("never runs more than `limit` at once and returns the results in input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5 * (11 - n)));
      running -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapBounded([], 4, async (n: number) => n)).toEqual([]);
    expect(await mapBounded([1, 2], 50, async (n) => n + 1)).toEqual([2, 3]);
  });

  it("rejects a limit below one instead of running nothing", async () => {
    await expect(mapBounded([1], 0, async (n) => n)).rejects.toThrow(/limit/);
  });
});
