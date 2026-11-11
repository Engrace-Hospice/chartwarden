// Slice 4 — a rotated credential's old tokens must not pile up: the cache keys on (org, clinician, config generation), and minting a token for
// a new generation drops that clinician's tokens of every OTHER generation (they can never be served again, and they are live bearer tokens).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExpirySweeper,
  evictOtherGenerations,
  pruneExpired,
  tokenCacheKey,
} from "../src/client/token-cache";

describe("token cache generations", () => {
  const tokens = () =>
    new Map<string, string>([
      [tokenCacheKey("org-1", "900", 1), "old"],
      [tokenCacheKey("org-1", "900", 2), "current"],
      [tokenCacheKey("org-1", "901", 1), "other clinician"],
      [tokenCacheKey("org-2", "900", 1), "other org"],
      [tokenCacheKey("org-1", "9001", 1), "clinician id that shares a prefix"],
    ]);

  it("drops the same clinician's tokens of other generations and nothing else", () => {
    const map = tokens();
    expect(evictOtherGenerations(map, "org-1", "900", tokenCacheKey("org-1", "900", 2))).toBe(1);
    expect([...map.values()].sort()).toEqual(
      ["clinician id that shares a prefix", "current", "other clinician", "other org"].sort(),
    );
  });

  it("keeps the generation it was told to keep, and is a no-op when there is nothing older", () => {
    const map = tokens();
    evictOtherGenerations(map, "org-1", "900", tokenCacheKey("org-1", "900", 2));
    expect(evictOtherGenerations(map, "org-1", "900", tokenCacheKey("org-1", "900", 2))).toBe(0);
    expect(map.get(tokenCacheKey("org-1", "900", 2))).toBe("current");
  });

  it("an env-served config (no version) is generation 0", () => {
    expect(tokenCacheKey("org-1", "900", undefined)).toBe(tokenCacheKey("org-1", "900", 0));
  });
});

describe("expired entries do not wait for a process exit", () => {
  afterEach(() => vi.useRealTimers());

  it("pruneExpired drops the expired and keeps the rest", () => {
    const map = new Map([
      ["old", 1],
      ["fresh", 9],
    ]);
    expect(pruneExpired(map, (n) => n < 5)).toBe(1);
    expect([...map.keys()]).toEqual(["fresh"]);
  });

  it("an armed sweep drops an entry nobody asks for again, then stops its own timer", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let clock = 0;
    const map = new Map([["org-gone", { expiresAt: 100 }]]);
    createExpirySweeper(map, (e) => e.expiresAt <= clock, 1_000)();
    expect(vi.getTimerCount()).toBe(1); // armed while the map holds something
    vi.advanceTimersByTime(1_000);
    expect(map.size).toBe(1); // not yet expired: untouched
    clock = 100;
    vi.advanceTimersByTime(1_000);
    expect(map.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // an empty cache keeps no timer running
  });

  it("arming twice runs one timer", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const map = new Map([["k", 1]]);
    const arm = createExpirySweeper(map, () => false, 1_000);
    arm();
    arm();
    expect(vi.getTimerCount()).toBe(1);
  });
});
