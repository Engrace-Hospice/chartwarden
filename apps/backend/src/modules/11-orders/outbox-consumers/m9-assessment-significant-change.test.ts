// wardenx -> chartwarden Valkey rename, release C: the banner is read from the chartwarden key only.
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { bannerKey, readBanner } from "./m9-assessment-significant-change";

const KEY = "chartwarden:m11:orders:suggestion:p1";
const LEGACY = "wardenx:m11:orders:suggestion:p1";
const entries = (id: string) => JSON.stringify([{ triggeringId: id }]);
const fake = (seed: Record<string, string>) =>
  ({
    async get(k: string) {
      return seed[k] ?? null;
    },
  }) as unknown as Redis;

describe("m11 suggestion banner key", () => {
  it("is the chartwarden key", () => {
    expect(bannerKey("p1")).toBe(KEY);
  });
  it("reads the chartwarden key", async () => {
    expect(await readBanner(fake({ [KEY]: entries("a") }), "p1")).toEqual([{ triggeringId: "a" }]);
  });
  it("ignores a legacy-only banner", async () => {
    expect(await readBanner(fake({ [LEGACY]: entries("old") }), "p1")).toEqual([]);
  });
  it("returns an empty banner on a miss and prefers the chartwarden key when both exist", async () => {
    expect(await readBanner(fake({}), "p1")).toEqual([]);
    const r = fake({ [KEY]: entries("new"), [LEGACY]: entries("old") });
    expect(await readBanner(r, "p1")).toEqual([{ triggeringId: "new" }]);
  });
});
