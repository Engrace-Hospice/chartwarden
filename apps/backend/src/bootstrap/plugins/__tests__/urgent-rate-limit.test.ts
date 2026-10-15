// WP 4.1 - the urgent POST limiter: per user, per org and per (sender, recipient) pair, all fail closed. The replay exemption is
// a DATABASE fact (the message is already stored for this recipient), never a counter: a request whose first try was refused
// created nothing, so its second try pays the budgets again.
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
const CH = "00000000-0000-0000-0000-0000000000c1";
const R1 = "00000000-0000-0000-0000-0000000000a1";
const R2 = "00000000-0000-0000-0000-0000000000a2";
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** The route handler stands in for the real send: only a request that gets past the limiter is "stored". */
function build(store: RateLimitStore, withReplayCheck = true) {
  const stored = new Map<string, string>(); // `${user}:${clientId}` -> recipient
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    const user = request.headers["x-test-user"];
    (request as { context?: unknown }).context = {
      correlationId: "cid",
      ...(typeof user === "string" ? { organizationId: ORG, userId: user } : {}),
    };
  });
  const limiter = buildUrgentRateLimit(store, {
    ...(withReplayCheck
      ? {
          isReplay: async (q) =>
            stored.get(`${q.userId}:${q.clientMessageId}`)?.toLowerCase() === q.recipientUserId,
        }
      : {}),
  });
  app.post("/channels/:id/u", { preHandler: [limiter] }, async (request) => {
    const b = request.body as { recipient_user_id: string; client_message_id: string };
    const user = (request as unknown as { context: { userId: string } }).context.userId;
    const key = `${user}:${b.client_message_id}`;
    if (!stored.has(key)) stored.set(key, b.recipient_user_id);
    return { ok: true };
  });
  return { app, stored };
}
type Built = ReturnType<typeof build>;
const send = ({ app }: Built, user: string | null, recipient: string, clientId: string = newId()) =>
  app.inject({
    method: "POST",
    url: `/channels/${CH}/u`,
    headers: user ? { "x-test-user": user } : {},
    payload: { recipient_user_id: recipient, client_message_id: clientId },
  });
const mem = () => createInMemoryRateLimitStore();

describe("urgent rate limit: budgets", () => {
  it("caps one sender to one recipient (pair) and answers 429 with Retry-After", async () => {
    const b = build(mem());
    for (let i = 0; i < URGENT_PAIR_LIMIT.max; i++)
      expect((await send(b, "u1", R1)).statusCode).toBe(200);
    const blocked = await send(b, "u1", R1);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(URGENT_PAIR_LIMIT.windowMs / 1000));
    expect((await send(b, "u1", R2)).statusCode).toBe(200); // another recipient is another bucket
    expect((await send(b, "u2", R1)).statusCode).toBe(200); // another sender is another bucket
  });

  it("caps one sender overall across recipients", async () => {
    const b = build(mem());
    for (let i = 0; i < URGENT_ROUTE_RATE_LIMIT.perUser; i++) {
      const r = `00000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`;
      expect((await send(b, "u1", r)).statusCode).toBe(200);
    }
    expect((await send(b, "u1", R1)).statusCode).toBe(429);
  });

  it("refuses an unauthenticated caller instead of leaving the route unlimited", async () => {
    expect((await send(build(mem()), null, R1)).statusCode).toBe(401);
  });

  it("fails closed (503) when the store throws, and never lets the send through", async () => {
    const broken = {
      increment: async () => {
        throw new Error("valkey down");
      },
    } as unknown as RateLimitStore;
    const b = build(broken);
    expect((await send(b, "u1", R1)).statusCode).toBe(503);
    expect(b.stored.size).toBe(0);
  });

  it("fails closed when only the pair bucket's store call fails", async () => {
    const real = mem();
    const flaky = {
      increment: async (key: string, windowMs: number) => {
        if (key.includes(":pair:")) throw new Error("down");
        return real.increment(key, windowMs);
      },
    } as unknown as RateLimitStore;
    const b = build(flaky);
    expect((await send(b, "u1", R1)).statusCode).toBe(503);
    expect(b.stored.size).toBe(0);
  });
});

describe("urgent rate limit: a refused request is never a replay", () => {
  it("(1) exhausted pair budget: a fresh id is refused, and resending the SAME id is refused again", async () => {
    const b = build(mem());
    for (let i = 0; i < URGENT_PAIR_LIMIT.max; i++) await send(b, "u1", R1);
    const stored = b.stored.size;
    const y = newId();
    expect((await send(b, "u1", R1, y)).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) expect((await send(b, "u1", R1, y)).statusCode).toBe(429);
    expect(b.stored.size).toBe(stored); // nothing past the cap was ever created
    expect(b.stored.has(`u1:${y}`)).toBe(false);
  });

  it("(2) exhausted per-user budget: a fresh id is refused, and resending the SAME id is refused again", async () => {
    const b = build(mem());
    for (let i = 0; i < URGENT_ROUTE_RATE_LIMIT.perUser; i++) {
      await send(b, "u1", `00000000-0000-0000-0000-0000000002${String(i).padStart(2, "0")}`);
    }
    const stored = b.stored.size;
    const y = newId();
    expect((await send(b, "u1", R2, y)).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) expect((await send(b, "u1", R2, y)).statusCode).toBe(429);
    expect(b.stored.size).toBe(stored);
  });

  it("(3) an ADMITTED message retried URGENT_RETRY_CAP times succeeds as a replay, then fresh sends still pass", async () => {
    const b = build(mem());
    const id = newId();
    expect((await send(b, "u1", R1, id)).statusCode).toBe(200); // admitted: uses 1 of the pair budget
    for (let i = 0; i < URGENT_RETRY_CAP; i++) {
      expect((await send(b, "u1", R1, id)).statusCode).toBe(200);
    }
    // the retries burned nothing: the remaining pair budget is intact
    for (let i = 0; i < URGENT_PAIR_LIMIT.max - 1; i++) {
      expect((await send(b, "u1", R1)).statusCode).toBe(200);
    }
    expect((await send(b, "u1", R1)).statusCode).toBe(429);
  });

  it("an admitted message's retries are bounded by their own cap", async () => {
    const b = build(mem());
    const id = newId();
    await send(b, "u1", R1, id);
    for (let i = 0; i < URGENT_RETRY_CAP; i++) await send(b, "u1", R1, id);
    expect((await send(b, "u1", R1, id)).statusCode).toBe(429);
  });

  it("(4) a different recipient on a reused admitted id is not a replay and pays the budgets", async () => {
    const b = build(mem());
    const id = newId();
    expect((await send(b, "u1", R1, id)).statusCode).toBe(200);
    for (let i = 0; i < URGENT_PAIR_LIMIT.max; i++) await send(b, "u1", R2);
    expect((await send(b, "u1", R2, id)).statusCode).toBe(429);
    expect(b.stored.get(`u1:${id}`)).toBe(R1); // the original is untouched
  });

  it("without a replay check there is no exemption at all", async () => {
    const b = build(mem(), false);
    const id = newId();
    for (let i = 0; i < URGENT_PAIR_LIMIT.max; i++) await send(b, "u1", R1, id);
    expect((await send(b, "u1", R1, id)).statusCode).toBe(429);
  });

  it("a replay lookup that throws is treated as not a replay (the budgets apply)", async () => {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      (request as { context?: unknown }).context = {
        correlationId: "c",
        organizationId: ORG,
        userId: "u1",
      };
    });
    const limiter = buildUrgentRateLimit(mem(), {
      isReplay: async () => {
        throw new Error("db down");
      },
    });
    app.post("/channels/:id/u", { preHandler: [limiter] }, async () => ({ ok: true }));
    const id = newId();
    const call = () =>
      app.inject({
        method: "POST",
        url: `/channels/${CH}/u`,
        payload: { recipient_user_id: R1, client_message_id: id },
      });
    for (let i = 0; i < URGENT_PAIR_LIMIT.max; i++) expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
  });

  it("builds keys only from UUIDs: a hostile recipient or message id never reaches a key", async () => {
    const keys: string[] = [];
    const real = mem();
    const spy = {
      increment: async (key: string, windowMs: number) => {
        keys.push(key);
        return real.increment(key, windowMs);
      },
    } as unknown as RateLimitStore;
    const b = build(spy);
    await send(b, "u1", "x:y:z;DROP", "not-a-uuid");
    expect(keys.some((k) => k.includes(":pair:") || k.includes(":replay:"))).toBe(false);
  });
});
