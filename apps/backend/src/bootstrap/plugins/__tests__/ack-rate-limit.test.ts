// WP 4.2 - the limiter on create and reassign: per user, per org and per (actor, named colleague) pair, all fail closed, no replay
// exemption (a repeat of a refused request pays again).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ACK_PAIR_LIMIT, ACK_ROUTE_RATE_LIMIT, buildAckRateLimit } from "../ack-rate-limit";
import { applyErrorHandler } from "../error-handler";
import { type RateLimitStore, createInMemoryRateLimitStore } from "../rate-limit-store";

const ORG = "00000000-0000-0000-0000-00000000000a";
const R1 = "00000000-0000-0000-0000-0000000000a1";
const R2 = "00000000-0000-0000-0000-0000000000a2";
const MSG = "00000000-0000-0000-0000-0000000000b1";

function build(store: RateLimitStore) {
  const reached: string[] = [];
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    const user = request.headers["x-test-user"];
    (request as { context?: unknown }).context = {
      correlationId: "cid",
      ...(typeof user === "string" ? { organizationId: ORG, userId: user } : {}),
    };
  });
  const limiter = buildAckRateLimit(store);
  app.post("/escalations", { preHandler: [limiter] }, async (request) => {
    reached.push((request.body as { assigned_user_id: string }).assigned_user_id);
    return { ok: true };
  });
  return { app, reached };
}
type Built = ReturnType<typeof build>;
const call = ({ app }: Built, user: string | null, assignee: unknown, extra: object = {}) =>
  app.inject({
    method: "POST",
    url: "/escalations",
    headers: user ? { "x-test-user": user } : {},
    payload: { message_id: MSG, assigned_user_id: assignee, ...extra },
  });

describe("ack rate limit", () => {
  it("caps one actor naming one colleague (pair) and answers 429 with Retry-After", async () => {
    const b = build(createInMemoryRateLimitStore());
    for (let i = 0; i < ACK_PAIR_LIMIT.max; i++) {
      expect((await call(b, "u1", R1)).statusCode).toBe(200);
    }

    const blocked = await call(b, "u1", R1);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(ACK_PAIR_LIMIT.windowMs / 1000));
    expect((await call(b, "u1", R2)).statusCode).toBe(200);
    expect((await call(b, "u2", R1)).statusCode).toBe(200);
  });

  it("a repeat of a refused request pays again (there is no replay exemption)", async () => {
    const b = build(createInMemoryRateLimitStore());
    for (let i = 0; i < ACK_PAIR_LIMIT.max; i++) await call(b, "u1", R1);
    const before = b.reached.length;

    expect((await call(b, "u1", R1)).statusCode).toBe(429);
    expect((await call(b, "u1", R1)).statusCode).toBe(429);

    expect(b.reached.length).toBe(before);
  });

  it("caps one user overall across colleagues", async () => {
    const b = build(createInMemoryRateLimitStore());
    for (let i = 0; i < ACK_ROUTE_RATE_LIMIT.perUser; i++) {
      const colleague = `00000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`;
      expect((await call(b, "u1", colleague)).statusCode).toBe(200);
    }

    expect((await call(b, "u1", R1)).statusCode).toBe(429);
  });

  it("rejects an anonymous caller before any bucket", async () => {
    const b = build(createInMemoryRateLimitStore());

    expect((await call(b, null, R1)).statusCode).toBe(401);
    expect(b.reached).toEqual([]);
  });

  it("leaves a malformed colleague id to the route schema and never puts it in a key", async () => {
    const seen: string[] = [];
    const real = createInMemoryRateLimitStore();
    const spy = {
      increment: async (key: string, windowMs: number) => {
        seen.push(key);
        return real.increment(key, windowMs);
      },
    } as unknown as RateLimitStore;
    const b = build(spy);

    await call(b, "u1", "../../etc/passwd");

    expect(seen.some((k) => k.includes("passwd"))).toBe(false);
    expect(seen.some((k) => k.includes(":pair:"))).toBe(false);
  });

  it("fails closed (503) when the store throws, and never lets the request through", async () => {
    const broken = {
      increment: async () => {
        throw new Error("valkey down");
      },
    } as unknown as RateLimitStore;
    const b = build(broken);

    expect((await call(b, "u1", R1)).statusCode).toBe(503);
    expect(b.reached).toEqual([]);
  });

  it("fails closed when only the pair bucket's store call fails", async () => {
    const real = createInMemoryRateLimitStore();
    const flaky = {
      increment: async (key: string, windowMs: number) => {
        if (key.includes(":pair:")) throw new Error("down");
        return real.increment(key, windowMs);
      },
    } as unknown as RateLimitStore;
    const b = build(flaky);

    expect((await call(b, "u1", R1)).statusCode).toBe(503);
    expect(b.reached).toEqual([]);
  });
});
