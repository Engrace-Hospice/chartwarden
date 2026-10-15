// WP 4.1 - the urgent POST limiter: per user, per org and per (sender, recipient) pair, all fail closed.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../error-handler";
import { type RateLimitStore, createInMemoryRateLimitStore } from "../rate-limit-store";
import {
  URGENT_PAIR_LIMIT,
  URGENT_RETRY_CAP,
  URGENT_ROUTE_RATE_LIMIT,
  buildUrgentRateLimit,
} from "../urgent-rate-limit";

const ORG = "00000000-0000-0000-0000-00000000000a";
const R1 = "00000000-0000-0000-0000-0000000000a1";
const R2 = "00000000-0000-0000-0000-0000000000a2";
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function build(store: RateLimitStore) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    const user = request.headers["x-test-user"];
    (request as { context?: unknown }).context = {
      correlationId: "cid",
      ...(typeof user === "string" ? { organizationId: ORG, userId: user } : {}),
    };
  });
  app.post("/u", { preHandler: [buildUrgentRateLimit(store)] }, async () => ({ ok: true }));
  return app;
}
const send = (
  app: ReturnType<typeof build>,
  user: string | null,
  recipient: string,
  clientId: string = newId(),
) =>
  app.inject({
    method: "POST",
    url: "/u",
    headers: user ? { "x-test-user": user } : {},
    payload: { recipient_user_id: recipient, client_message_id: clientId },
  });

describe("urgent rate limit", () => {
  it("caps one sender to one recipient (pair) and answers 429 with Retry-After", async () => {
    const app = build(createInMemoryRateLimitStore());
    for (let i = 0; i < URGENT_PAIR_LIMIT.max; i++) {
      expect((await send(app, "u1", R1)).statusCode).toBe(200);
    }
    const blocked = await send(app, "u1", R1);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(URGENT_PAIR_LIMIT.windowMs / 1000));
    expect((await send(app, "u1", R2)).statusCode).toBe(200); // another recipient is another bucket
    expect((await send(app, "u2", R1)).statusCode).toBe(200); // another sender is another bucket
  });

  it("caps one sender overall across recipients", async () => {
    const app = build(createInMemoryRateLimitStore());
    for (let i = 0; i < URGENT_ROUTE_RATE_LIMIT.perUser; i++) {
      const r = `00000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`;
      expect((await send(app, "u1", r)).statusCode).toBe(200);
    }
    expect((await send(app, "u1", R1)).statusCode).toBe(429);
  });

  it("refuses an unauthenticated caller instead of leaving the route unlimited", async () => {
    expect((await send(build(createInMemoryRateLimitStore()), null, R1)).statusCode).toBe(401);
  });

  it("fails closed (503) when the store throws, and never lets the send through", async () => {
    const broken: RateLimitStore = {
      increment: async () => {
        throw new Error("valkey down");
      },
    } as unknown as RateLimitStore;
    const res = await send(build(broken), "u1", R1);
    expect(res.statusCode).toBe(503);
  });

  it("fails closed when only the pair bucket's store call fails", async () => {
    const real = createInMemoryRateLimitStore();
    let calls = 0;
    const flaky: RateLimitStore = {
      increment: async (key: string, windowMs: number) => {
        calls += 1;
        if (key.includes(":pair:")) throw new Error("down");
        return real.increment(key, windowMs);
      },
    } as unknown as RateLimitStore;
    expect((await send(build(flaky), "u1", R1)).statusCode).toBe(503);
    expect(calls).toBeGreaterThan(1);
  });

  it("a retry of the same message never burns the budgets, so a flaky network cannot lock the sender out", async () => {
    const app = build(createInMemoryRateLimitStore());
    const id = newId();
    for (let i = 0; i < URGENT_RETRY_CAP; i++) {
      expect((await send(app, "u1", R1, id)).statusCode).toBe(200);
    }
    // ...and the sender can still send fresh messages to the same recipient afterwards (only 1 of 5 pair slots used)
    for (let i = 0; i < URGENT_PAIR_LIMIT.max - 1; i++) {
      expect((await send(app, "u1", R1)).statusCode).toBe(200);
    }
    expect((await send(app, "u1", R1)).statusCode).toBe(429);
  });

  it("bounds retries of one message with their own cap", async () => {
    const app = build(createInMemoryRateLimitStore());
    const id = newId();
    for (let i = 0; i < URGENT_RETRY_CAP; i++) await send(app, "u1", R1, id);
    expect((await send(app, "u1", R1, id)).statusCode).toBe(429);
  });

  it("builds keys only from UUIDs: a hostile recipient or message id never reaches a key", async () => {
    const keys: string[] = [];
    const real = createInMemoryRateLimitStore();
    const spy = {
      increment: async (key: string, windowMs: number) => {
        keys.push(key);
        return real.increment(key, windowMs);
      },
    } as unknown as RateLimitStore;
    const app = build(spy);
    await send(app, "u1", "x:y:z;DROP", "not-a-uuid");
    expect(keys.some((k) => k.includes(":pair:") || k.includes(":seen:"))).toBe(false);
  });
});
