// wardenx -> chartwarden Valkey rename, release C: the lockout counter and challenges use the chartwarden prefix only.
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { createValkeyStepUpChallengeStore } from "./step-up-challenge-valkey";

function fakeRedis() {
  const strings = new Map<string, string>();
  const ttl = new Map<string, number>();
  const redis = {
    async get(k: string) {
      return strings.get(k) ?? null;
    },
    async set(k: string, v: string) {
      strings.set(k, v);
      return "OK";
    },
    async incr(k: string) {
      const n = Number(strings.get(k) ?? 0) + 1;
      strings.set(k, String(n));
      return n;
    },
    async expire(k: string, sec: number) {
      ttl.set(k, sec);
      return 1;
    },
    async del(...ks: string[]) {
      for (const k of ks) strings.delete(k);
      return ks.length;
    },
  };
  return { redis: redis as unknown as Redis, strings, ttl };
}

describe("step-up lockout (chartwarden prefix only)", () => {
  it("counts, expires and clears failures under the chartwarden key only", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await store.recordFailure("s1");
    await store.recordFailure("s1");
    expect([...f.strings.keys()]).toEqual(["chartwarden:m2:step-up:failures:s1"]);
    expect(await store.recentFailureCount("s1")).toBe(2);
    expect(f.ttl.get("chartwarden:m2:step-up:failures:s1")).toBe(60);
    await store.clearFailures("s1");
    expect(await store.recentFailureCount("s1")).toBe(0);
    expect(f.strings.size).toBe(0);
  });

  it("ignores a legacy counter", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await f.redis.set("wardenx:m2:step-up:failures:s2", "5");
    expect(await store.recentFailureCount("s2")).toBe(0);
    await store.recordFailure("s2");
    expect(await store.recentFailureCount("s2")).toBe(1);
  });

  it("stores challenges under the chartwarden prefix", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await store.put("c1", { a: 1 } as never, 30);
    expect([...f.strings.keys()]).toEqual(["chartwarden:m2:step-up:challenge:c1"]);
  });
});
