// wardenx -> chartwarden Valkey rename, release B (source unchanged; the counter already reads the max of both): the lockout counter spans both prefixes; challenges use the new prefix only.
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

describe("step-up lockout across prefixes", () => {
  it("counts failures written by an old pod (legacy key) and dual-writes new ones", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await f.redis.set("wardenx:m2:step-up:failures:s1", "2"); // old pod
    expect(await store.recentFailureCount("s1")).toBe(2);
    await store.recordFailure("s1");
    expect(f.strings.get("wardenx:m2:step-up:failures:s1")).toBe("3");
    expect(f.strings.get("chartwarden:m2:step-up:failures:s1")).toBe("1");
    expect(await store.recentFailureCount("s1")).toBe(3);
    expect(f.ttl.get("chartwarden:m2:step-up:failures:s1")).toBe(60);
  });

  it("writes failures to the legacy key too (so old pods see them) and clears both", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await store.recordFailure("s2");
    expect(f.strings.get("wardenx:m2:step-up:failures:s2")).toBe("1");
    await store.clearFailures("s2");
    expect(await store.recentFailureCount("s2")).toBe(0);
    expect(f.strings.size).toBe(0);
  });

  it("stores challenges under the new prefix only", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await store.put("c1", { a: 1 } as never, 30);
    expect([...f.strings.keys()]).toEqual(["chartwarden:m2:step-up:challenge:c1"]);
  });

  it("reads a new-only counter, a legacy-only counter, and 0 on a miss", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    expect(await store.recentFailureCount("s3")).toBe(0);
    await f.redis.set("chartwarden:m2:step-up:failures:s3", "4");
    expect(await store.recentFailureCount("s3")).toBe(4);
    await f.redis.set("wardenx:m2:step-up:failures:s4", "5");
    expect(await store.recentFailureCount("s4")).toBe(5);
  });

  it("does not double count: both present reads the max, one failure adds exactly 1", async () => {
    const f = fakeRedis();
    const store = createValkeyStepUpChallengeStore(f.redis);
    await f.redis.set("wardenx:m2:step-up:failures:s5", "3");
    await f.redis.set("chartwarden:m2:step-up:failures:s5", "3");
    expect(await store.recentFailureCount("s5")).toBe(3);
    await store.recordFailure("s5");
    expect(await store.recentFailureCount("s5")).toBe(4);
  });
});
