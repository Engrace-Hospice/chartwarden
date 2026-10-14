// ADR-0058 review F1 - the response-time floor, over a virtual clock (no real waiting).
import { describe, expect, it } from "vitest";
import {
  type FloorClock,
  SEARCH_RESPONSE_FLOOR_MS,
  SEARCH_RESPONSE_JITTER_MS,
  responseFloorFromEnv,
  withResponseFloor,
} from "../src/modules/36-messaging/global-search/timing-floor";

const CONFIG = { floorMs: 1000, jitterMs: 200 };

/** A virtual clock: `sleep` advances time, `work` advances it by its own cost. */
function virtualClock(random = 0.5) {
  let t = 0;
  const clock: FloorClock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => random,
  };
  return {
    clock,
    spend: (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}

describe("search response floor (F1)", () => {
  it("has production defaults above the one-round worst case", () => {
    expect(SEARCH_RESPONSE_FLOOR_MS).toBeGreaterThanOrEqual(1000);
    expect(SEARCH_RESPONSE_JITTER_MS).toBeGreaterThan(0);
  });

  it("takes the same minimum time for 0 hits and for 1 hidden hit", async () => {
    const empty = virtualClock();
    await withResponseFloor(async () => empty.spend(5), CONFIG, empty.clock);
    const hiddenHit = virtualClock();
    await withResponseFloor(async () => hiddenHit.spend(400), CONFIG, hiddenHit.clock);
    expect(empty.elapsed()).toBe(1100);
    expect(hiddenHit.elapsed()).toBe(1100);
  });

  it("holds errors to the floor and rethrows them", async () => {
    const v = virtualClock();
    await expect(
      withResponseFloor(
        async () => {
          v.spend(3);
          throw new Error("refused after the gate");
        },
        CONFIG,
        v.clock,
      ),
    ).rejects.toThrow("refused after the gate");
    expect(v.elapsed()).toBe(1100);
  });

  it("never shortens a request slower than the floor", async () => {
    const v = virtualClock(0);
    const result = await withResponseFloor(
      async () => {
        v.spend(4000);
        return "slow";
      },
      CONFIG,
      v.clock,
    );
    expect(result).toBe("slow");
    expect(v.elapsed()).toBe(4000);
  });

  it("adds per-request jitter within [floor, floor + jitter)", async () => {
    const low = virtualClock(0);
    await withResponseFloor(async () => undefined, CONFIG, low.clock);
    const high = virtualClock(0.999);
    await withResponseFloor(async () => undefined, CONFIG, high.clock);
    expect(low.elapsed()).toBe(1000);
    expect(high.elapsed()).toBeGreaterThan(1000);
    expect(high.elapsed()).toBeLessThan(1200);
  });

  describe("env overrides (security L3)", () => {
    const overrides = {
      WARDENX_GLOBAL_SEARCH_FLOOR_MS: "0",
      WARDENX_GLOBAL_SEARCH_JITTER_MS: "0",
    };
    const production = {
      floorMs: SEARCH_RESPONSE_FLOOR_MS,
      jitterMs: SEARCH_RESPONSE_JITTER_MS,
    };

    it("honours the overrides only when NODE_ENV is test", () => {
      expect(responseFloorFromEnv({ NODE_ENV: "test", ...overrides })).toEqual({
        floorMs: 0,
        jitterMs: 0,
      });
    });

    it("ignores them under development or an unset NODE_ENV", () => {
      expect(responseFloorFromEnv({ NODE_ENV: "development", ...overrides })).toEqual(production);
      expect(responseFloorFromEnv({ ...overrides })).toEqual(production);
    });

    it("fails boot when they are set under a production or staging NODE_ENV", () => {
      for (const NODE_ENV of ["production", "staging", "Production"]) {
        expect(() => responseFloorFromEnv({ NODE_ENV, ...overrides })).toThrow(/must not be set/);
      }
      expect(responseFloorFromEnv({ NODE_ENV: "production" })).toEqual(production);
    });
  });
});
