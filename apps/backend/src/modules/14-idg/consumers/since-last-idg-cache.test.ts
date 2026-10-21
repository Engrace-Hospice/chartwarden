// wardenx -> chartwarden Valkey rename, release A: dual-write both keys (30 d TTL), read legacy.
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import {
  SINCE_LAST_IDG_TTL_SEC,
  appendSinceLastIdgEntry,
  cacheKeys,
  readSinceLastIdgEntry,
} from "./since-last-idg-cache";

describe("since-last-idg cache dual-write", () => {
  it("writes both keys with the 30 d TTL and reads legacy", async () => {
    const strings = new Map<string, string>();
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

    await appendSinceLastIdgEntry(redis, "p1", "orderChanges", "d1", { _digestId: "d1" } as never);

    const { legacyKey, newKey } = cacheKeys("p1");
    expect(legacyKey).toBe("wardenx:m14:idg:since-last-idg:p1");
    expect(newKey).toBe("chartwarden:m14:idg:since-last-idg:p1");
    expect(strings.get(newKey)).toBe(strings.get(legacyKey));
    expect(ttl.get(legacyKey)).toBe(SINCE_LAST_IDG_TTL_SEC);
    expect(ttl.get(newKey)).toBe(SINCE_LAST_IDG_TTL_SEC);
    strings.delete(newKey);
    expect((await readSinceLastIdgEntry(redis, "p1")).orderChanges).toHaveLength(1);
  });
});
