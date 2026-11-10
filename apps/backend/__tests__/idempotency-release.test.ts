/**
 * A retryable failure must not be replayed. The error handler answers a deadlock / serialization failure with
 * `409 CONCURRENT_UPDATE` ("nothing was saved; retry it"), and any 5xx says the write did not complete. The
 * idempotency middleware used to `complete` every response, so a same-key retry got the cached failure back for the
 * whole 24h TTL while the write never ran. These outcomes now RELEASE the claim, so the same key runs again, PROVIDED the
 * request committed nothing (these handlers fail before any write; the committed-then-failed half is
 * `idempotency-commit-tracker.test.ts`); every other outcome (a 201, a business-rule 409, a 4xx) is still cached and replayed.
 * If the release itself fails (the store is down) the key stays pending: a retry is a 409 in flight until the TTL.
 *
 * Unit level over the in-memory store; the Postgres store's `release` is proved in
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

describe("in-memory IdempotencyStore.release", () => {
  it("drops the claimant's own pending record so the key can be claimed again", async () => {
    const store = createInMemoryIdempotencyStore();
    await store.putPending(ORG, "k", "h");
    await store.release(ORG, "k", "h");
    expect(await store.load(ORG, "k")).toBeNull();
    expect(await store.putPending(ORG, "k", "h")).toBe(true);
  });

  it("leaves a pending record that another claimant's fingerprint owns", async () => {
    const store = createInMemoryIdempotencyStore();
    await store.putPending(ORG, "k", "owner");
    await store.release(ORG, "k", "someone-else");
    expect(await store.load(ORG, "k")).toEqual({ state: "pending", requestHash: "owner" });
  });

  it("never deletes a completed response", async () => {
    const store = createInMemoryIdempotencyStore();
    await store.putPending(ORG, "k", "h");
    await store.complete(ORG, "k", { status: "201", body: { id: 1 } });
    await store.release(ORG, "k", "h");
    expect(await store.load(ORG, "k")).toMatchObject({ state: "complete", requestHash: "h" });
  });

  it("is a no-op for an absent key", async () => {
    const store = createInMemoryIdempotencyStore();
    await expect(store.release(ORG, "missing", "h")).resolves.toBeUndefined();
  });
});

describe("applyIdempotency — a retryable failure is not replayed", () => {
  let app: FastifyInstance;
  let runs: number;

  async function build(
    handler: (run: number, reply: import("fastify").FastifyReply) => unknown,
    store = createInMemoryIdempotencyStore(),
  ): Promise<void> {
    runs = 0;
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        organizationId: ORG,
        correlationId: "cid-test",
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, store);
    app.post("/write", async (_request, reply) => {
      runs += 1;
      return handler(runs, reply);
    });
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  const post = (key = "key-1") =>
    app.inject({
      method: "POST",
      url: "/write",
      headers: { "idempotency-key": key },
      payload: { a: 1 },
    });

  const deadlock = (): Error =>
    Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" });

  it("a deadlock 409 (CONCURRENT_UPDATE) frees the key: the same-key retry runs the write", async () => {
    await build((run, reply) => {
      if (run === 1) throw deadlock();
      return reply.code(201).send({ saved: true });
    });
    const first = await post();
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe("CONCURRENT_UPDATE");
    const retry = await post();
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual({ saved: true });
    expect(runs).toBe(2);
  });

  it("a 5xx frees the key: the same-key retry runs the write", async () => {
    await build((run, reply) => {
      if (run === 1) return reply.code(503).send({ error: { code: "DEGRADED" } });
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(503);
    const retry = await post();
    expect(retry.statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("an unexpected 500 frees the key", async () => {
    await build((run, reply) => {
      if (run === 1) throw new Error("boom");
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(500);
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("a business-rule 409 (any other code) is still cached and replayed", async () => {
    await build((_run, reply) => reply.code(409).send({ error: { code: "CONFLICT" } }));
    const first = await post();
    const replay = await post();
    expect(first.statusCode).toBe(409);
    expect(replay.statusCode).toBe(409);
    expect(runs).toBe(1);
  });

  it("a 4xx and a 2xx are still cached and replayed", async () => {
    await build((_run, reply) => reply.code(422).send({ error: { code: "VALIDATION_ERROR" } }));
    await post();
    expect((await post()).statusCode).toBe(422);
    expect(runs).toBe(1);
    await app.close();
    await build((_run, reply) => reply.code(201).send({ saved: true }));
    await post();
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(1);
  });

  it("a release that fails leaves the key pending (fail-safe 409 in flight), never rewrites the response", async () => {
    const base = createInMemoryIdempotencyStore();
    const failing = {
      ...base,
      release: async () => {
        throw new Error("store unavailable");
      },
    };
    await build((_run, reply) => reply.code(503).send({ error: { code: "DEGRADED" } }), failing);
    const first = await post();
    expect(first.statusCode).toBe(503);
    const retry = await post();
    expect(retry.statusCode).toBe(409);
    expect(runs).toBe(1);
  });
});
