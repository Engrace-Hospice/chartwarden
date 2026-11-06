// Slice 4 — a rotated credential's old tokens must not pile up: the cache keys on (org, clinician, config generation), and minting a token for
// a new generation drops that clinician's tokens of every OTHER generation (they can never be served again, and they are live bearer tokens).
import { describe, expect, it } from "vitest";
import { evictOtherGenerations, tokenCacheKey } from "../src/client/token-cache";

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
