/**
 * WX-PR-017 — the cluster-wide rate-limit store, proved against a real Valkey/Redis.
 *
 * The whole point of `createRedisRateLimitStore` is that TWO backend replicas sharing one Redis
 * connection enforce ONE combined limit, not one limit each — the exact gap the in-memory `Map`
 * store has. This test builds two independent `ioredis` clients (standing in for two backend
 * processes) against the SAME server and interleaves their increments, proving the shared counter
 * is exact, not merely "probably fine" — and separately proves the fixed-window expiry actually
 * resets the count instead of accumulating forever.
 *
 * WARDENX_TEST_REDIS_URL=redis://localhost:6399 bunx vitest run \
 *   apps/backend/src/bootstrap/plugins/__tests__/rate-limit-store.live.test.ts
 */
import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRedisRateLimitStore } from "../rate-limit-store";

const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("createRedisRateLimitStore — LIVE Redis/Valkey (WX-PR-017)", () => {
  // Constructed in beforeAll, NOT at describe-body eval time: `describe.skipIf` still EXECUTES the
  // describe callback to discover its `it()`s even when every test inside is skipped, so a
  // `new Redis(...)` at this level would eagerly attempt a connection (and log ioredis's unhandled
  // "AggregateError" noise) on every `bun run test` run that has no Redis configured — i.e. always,
  // outside this file's own live invocation.
  let clientA: Redis;
  let clientB: Redis;
  const testKey = `wx-pr-017-test:${crypto.randomUUID()}`;
  // The store namespaces every key under `ratelimit:` internally (rate-limit-store.ts) — cleanup
  // must target the SAME prefixed key the store actually writes, not the bare `testKey`.
  const redisKey = `ratelimit:${testKey}`;

  beforeEach(async () => {
    if (!clientA) {
      clientA = new Redis(REDIS_URL as string);
      clientB = new Redis(REDIS_URL as string);
    }
    await clientA.del(redisKey);
  });

  afterAll(async () => {
    await clientA?.del(redisKey);
    await clientA?.quit();
    await clientB?.quit();
  });

  it("two independent connections (standing in for two replicas) share ONE counter", async () => {
    const storeA = createRedisRateLimitStore(clientA);
    const storeB = createRedisRateLimitStore(clientB);
    // Interleave increments across both "replicas" — a per-process Map would see 3 + 3 = two
    // independent windows of 3; the shared store must see one window of 6.
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      counts.push(await storeA.increment(testKey, 60_000));
      counts.push(await storeB.increment(testKey, 60_000));
    }
    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("concurrent increments from both connections are exact (no lost updates)", async () => {
    const storeA = createRedisRateLimitStore(clientA);
    const storeB = createRedisRateLimitStore(clientB);
    const results = await Promise.all([
      ...Array.from({ length: 25 }, () => storeA.increment(testKey, 60_000)),
      ...Array.from({ length: 25 }, () => storeB.increment(testKey, 60_000)),
    ]);
    expect(new Set(results).size).toBe(50); // every increment got a distinct sequential count
    expect(Math.max(...results)).toBe(50);
  });

  it("the window expires and resets the count, rather than accumulating forever", async () => {
    const store = createRedisRateLimitStore(clientA);
    const first = await store.increment(testKey, 300); // 300ms window
    expect(first).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterExpiry = await store.increment(testKey, 300);
    expect(afterExpiry).toBe(1); // NOT 2 — the key expired and started a fresh window
  });
});
