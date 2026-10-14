import Fastify from "fastify";
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
import { applyErrorHandler } from "../error-handler";
import { createRedisRateLimitStore } from "../rate-limit-store";
import { GLOBAL_SEARCH_ROUTE_RATE_LIMIT, createRouteRateLimit } from "../route-rate-limit";

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

// WP 2.14 / ADR-0058 P2 — the per-route limiter proved over a real Valkey with the ADR's decided
// numbers: the 31st request in a minute by one user is 429; a second user in the same org is
// unaffected until the org cap; the org cap is shared across replicas; a store outage is 503 on a
// fail-closed route while a fail-open route still serves.
describe.skipIf(!REDIS_URL)("createRouteRateLimit — LIVE Valkey (ADR-0058 P2)", () => {
  const runId = crypto.randomUUID();
  const org = crypto.randomUUID();
  const clients: Redis[] = [];

  function replica(redis: Redis, failMode: "closed" | "open" = "closed") {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      const user = request.headers["x-test-user"];
      (request as { context?: unknown }).context = {
        correlationId: "cid-live",
        organizationId: org,
        userId: user,
      };
    });
    const limited = createRouteRateLimit({
      store: createRedisRateLimitStore(redis),
      limit: { ...GLOBAL_SEARCH_ROUTE_RATE_LIMIT, failMode },
      keyPrefix: `live-${runId}`,
    });
    app.get("/search", { preHandler: [limited] }, async () => ({ ok: true }));
    return app;
  }
  const as = (app: ReturnType<typeof replica>, user: string) =>
    app.inject({ method: "GET", url: "/search", headers: { "x-test-user": user } });

  afterAll(async () => {
    const keys = await clients[0]?.keys(`ratelimit:live-${runId}:*`);
    if (keys?.length) await clients[0]?.del(...keys);
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  it("enforces 30/user and 300/org across two replicas, with TTL on every key", async () => {
    const a = new Redis(REDIS_URL as string);
    const b = new Redis(REDIS_URL as string);
    clients.push(a, b);
    const appA = replica(a);
    const appB = replica(b);

    for (let i = 0; i < 30; i++) {
      expect((await as(i % 2 ? appA : appB, "u1")).statusCode).toBe(200);
    }
    const blocked = await as(appA, "u1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect((await as(appB, "u2")).statusCode).toBe(200); // second user, same org: unaffected

    // org used so far: 30 (u1) + 1 (u2) = 31; fill to 300 across both replicas with fresh users.
    for (let i = 0; i < 269; i++) {
      expect((await as(i % 2 ? appA : appB, `fill-${i % 20}`)).statusCode).toBe(200);
    }
    expect((await as(appB, "late-user")).statusCode).toBe(429);

    const keys = await a.keys(`ratelimit:live-${runId}:*`);
    expect(keys.length).toBeGreaterThan(2);
    for (const key of keys) {
      const ttl = await a.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    }
  });

  it("a store outage is 503 on a fail-closed route and allowed on a fail-open one", async () => {
    // Port 1 refuses connections; no offline queue + no retries makes the command reject at once.
    const dead = new Redis({
      host: "127.0.0.1",
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on("error", () => undefined);
    clients.push(dead);
    const closed = await as(replica(dead, "closed"), "u1");
    expect(closed.statusCode).toBe(503);
    expect(closed.json()).toMatchObject({ error: { code: "DEGRADED" } });
    expect((await as(replica(dead, "open"), "u1")).statusCode).toBe(200);
  });
});
