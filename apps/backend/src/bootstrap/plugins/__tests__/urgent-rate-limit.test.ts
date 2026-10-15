// WP 4.1 - the urgent POST limiter: per user, per org and per (sender, recipient) pair, all fail closed.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../error-handler";
import { type RateLimitStore, createInMemoryRateLimitStore } from "../rate-limit-store";
import {
  URGENT_PAIR_LIMIT,
  URGENT_ROUTE_RATE_LIMIT,
  buildUrgentRateLimit,
} from "../urgent-rate-limit";

const ORG = "00000000-0000-0000-0000-00000000000a";
const R1 = "00000000-0000-0000-0000-0000000000a1";
const R2 = "00000000-0000-0000-0000-0000000000a2";

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
const send = (app: ReturnType<typeof build>, user: string | null, recipient: string) =>
  app.inject({
    method: "POST",
    url: "/u",
    headers: user ? { "x-test-user": user } : {},
    payload: { recipient_user_id: recipient },
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
});
