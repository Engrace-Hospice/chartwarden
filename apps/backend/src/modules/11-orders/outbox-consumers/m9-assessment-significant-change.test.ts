// wardenx -> chartwarden Valkey rename, release B: read the new key, fall back to the legacy key on a miss.
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { bannerKeys, readBanner } from "./m9-assessment-significant-change";

const NEW = "chartwarden:m11:orders:suggestion:p1";
const LEGACY = "wardenx:m11:orders:suggestion:p1";
const entries = (id: string) => JSON.stringify([{ triggeringId: id }]);
const fake = (seed: Record<string, string>) =>
  ({
    async get(k: string) {
      return seed[k] ?? null;
    },
  }) as unknown as Redis;

describe("m11 suggestion banner keys", () => {
  it("yields the legacy and new key for a patient", () => {
    expect(bannerKeys("p1")).toEqual({ legacyKey: LEGACY, newKey: NEW });
  });
});

describe("m11 suggestion banner read (release B)", () => {
  it("reads the new key when only it is present", async () => {
    expect(await readBanner(fake({ [NEW]: entries("a") }), "p1")).toEqual([{ triggeringId: "a" }]);
  });
  it("falls back to the legacy key when the new key misses (pre-release-A banner)", async () => {
    expect(await readBanner(fake({ [LEGACY]: entries("old") }), "p1")).toEqual([
      { triggeringId: "old" },
    ]);
  });
  it("returns an empty banner when both miss", async () => {
    expect(await readBanner(fake({}), "p1")).toEqual([]);
  });
  it("prefers the new key when both are present", async () => {
    const r = fake({ [NEW]: entries("new"), [LEGACY]: entries("old") });
    expect(await readBanner(r, "p1")).toEqual([{ triggeringId: "new" }]);
  });
});
