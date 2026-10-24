// wardenx -> chartwarden Valkey rename, release C: only the chartwarden key is written and read (30 d TTL).
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import {
  SINCE_LAST_IDG_TTL_SEC,
  appendSinceLastIdgEntry,
  cacheKey,
  readSinceLastIdgEntry,
} from "./since-last-idg-cache";

const KEY = "chartwarden:m14:idg:since-last-idg:p9";
const LEGACY = "wardenx:m14:idg:since-last-idg:p9";
const digest = (id: string) => JSON.stringify({ orderChanges: [{ _digestId: id }] });

function fake(seed: Record<string, string> = {}) {
  const strings = new Map(Object.entries(seed));
  const ttl = new Map<string, number>();
  const redis = {
    async get(k: string) {
      return strings.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: string, sec: number) {
      strings.set(k, v);
      ttl.set(k, sec);
      return "OK";
    },
  } as unknown as Redis;
  return { redis, strings, ttl };
}

describe("since-last-idg cache (chartwarden key only)", () => {
  it("builds the chartwarden key", () => {
    expect(cacheKey("p9")).toBe(KEY);
  });

  it("writes only the chartwarden key with the 30 d TTL and reads it back", async () => {
    const f = fake();
    await appendSinceLastIdgEntry(f.redis, "p9", "orderChanges", "d1", {
      _digestId: "d1",
    } as never);
    expect([...f.strings.keys()]).toEqual([KEY]);
    expect(f.ttl.get(KEY)).toBe(SINCE_LAST_IDG_TTL_SEC);
    expect((await readSinceLastIdgEntry(f.redis, "p9")).orderChanges).toHaveLength(1);
  });

  it("ignores a legacy-only key", async () => {
    const f = fake({ [LEGACY]: digest("old") });
    expect((await readSinceLastIdgEntry(f.redis, "p9")).orderChanges).toEqual([]);
  });

  it("returns the empty entry on a miss and reads only the chartwarden key when both exist", async () => {
    expect((await readSinceLastIdgEntry(fake().redis, "p9")).orderChanges).toEqual([]);
    const f = fake({ [KEY]: digest("new"), [LEGACY]: digest("old") });
    expect((await readSinceLastIdgEntry(f.redis, "p9")).orderChanges).toEqual([
      { _digestId: "new" },
    ]);
  });
});
