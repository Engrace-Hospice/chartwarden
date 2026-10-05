/**
 * GAP-007 — the Idempotency-Key guard must CLAIM atomically.
 *
 * Before: `putPending` returned void and the middleware never asked whether it had won, so two
 * concurrent requests with the same key both ran the handler; and an expired key was treated as
 * absent on every retry, so each retry re-executed. Now `putPending` returns the claim result
 * (`true` = this caller owns the key), a lost claim reloads and answers 409 / replays, and an
 * expired key is re-claimed fresh and then replays.
 *
 * Unit level over the in-memory store; the Postgres store is proved in
 * `gap-007-idempotency-claim.live.test.ts`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("in-memory IdempotencyStore claim semantics", () => {
  it("putPending returns true for the first claimer and false for a concurrent duplicate", async () => {
    const store = createInMemoryIdempotencyStore();
    const results = await Promise.all([
      store.putPending(ORG, "k", "h"),
      store.putPending(ORG, "k", "h"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a lost claim does not clobber the winner's record", async () => {
    const store = createInMemoryIdempotencyStore();
    await store.putPending(ORG, "k", "winner");
    await store.complete(ORG, "k", { status: "201", body: { id: 1 } });
    expect(await store.putPending(ORG, "k", "loser")).toBe(false);
    expect(await store.load(ORG, "k")).toMatchObject({ state: "complete", requestHash: "winner" });
  });

  it("scopes claims by organization", async () => {
    const store = createInMemoryIdempotencyStore();
    expect(await store.putPending(ORG, "k", "h")).toBe(true);
    expect(await store.putPending(OTHER_ORG, "k", "h")).toBe(true);
  });

  it("treats an expired record as absent and lets a new caller claim it fresh", async () => {
    let now = 1_000_000;
    const store = createInMemoryIdempotencyStore({ now: () => now });
    await store.putPending(ORG, "k", "old");
    await store.complete(ORG, "k", { status: "201", body: { id: 1 } });
    now += DAY_MS + 1;
    expect(await store.load(ORG, "k")).toBeNull();
    expect(await store.putPending(ORG, "k", "new")).toBe(true);
    expect(await store.load(ORG, "k")).toEqual({ state: "pending", requestHash: "new" });
  });

  it("does not let an unexpired record be re-claimed", async () => {
    let now = 1_000_000;
    const store = createInMemoryIdempotencyStore({ now: () => now });
    await store.putPending(ORG, "k", "h");
    now += DAY_MS - 1;
    expect(await store.putPending(ORG, "k", "h")).toBe(false);
  });
});

describe("applyIdempotency middleware — claim-aware", () => {
  let app: FastifyInstance;
  let now: number;
  let handlerRuns: number;
  let release: () => void;

  async function build(): Promise<void> {
    now = 1_000_000;
    handlerRuns = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = { organizationId: ORG };
    });
    applyErrorHandler(app);
    applyIdempotency(app, createInMemoryIdempotencyStore({ now: () => now }));
    app.post("/slow", async (_request, reply) => {
      handlerRuns += 1;
      await gate;
      return reply.code(201).send({ run: handlerRuns });
    });
    app.post("/fast", async (_request, reply) => {
      handlerRuns += 1;
      return reply.code(201).send({ run: handlerRuns });
    });
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  const post = (url: string, key = "key-1", payload: unknown = { a: 1 }) =>
    app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": key },
      payload: payload as object,
    });

  it("two concurrent POSTs with one key run the handler once; the loser gets 409, not a re-run", async () => {
    await build();
    const first = post("/slow");
    // Let the first request win the claim and park inside the handler.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post("/slow");
    expect(second.statusCode).toBe(409);
    release();
    const firstRes = await first;
    expect(firstRes.statusCode).toBe(201);
    expect(handlerRuns).toBe(1);
  });

  it("a truly simultaneous pair still runs the handler once", async () => {
    await build();
    release();
    const [a, b] = await Promise.all([post("/fast"), post("/fast")]);
    expect(handlerRuns).toBe(1);
    // The loser either saw the winner still pending (409) or already complete (replay, 201).
    expect([a.statusCode, b.statusCode]).toContain(201);
    for (const res of [a, b]) expect([201, 409]).toContain(res.statusCode);
  });

  it("replays the stored response for a same-body retry after completion", async () => {
    await build();
    const first = await post("/fast");
    const replay = await post("/fast");
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(handlerRuns).toBe(1);
  });

  it("an expired key claims fresh (handler runs again once) and then replays", async () => {
    await build();
    await post("/fast");
    now += DAY_MS + 1;
    const fresh = await post("/fast");
    expect(fresh.statusCode).toBe(201);
    expect(handlerRuns).toBe(2);
    const replay = await post("/fast");
    expect(replay.json()).toEqual(fresh.json());
    expect(handlerRuns).toBe(2);
  });
});
