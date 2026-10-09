/**
 * GAP-020 -- a route that returns a ONE-TIME SECRET (the wristband issue route returns the raw token once) must
 * be able to opt out of Idempotency-Key capture. The shared web client attaches a random Idempotency-Key to
 * every mutation, so rejecting the header would 400 every browser call; but capturing the response would copy the
 * secret into `idempotency_key.response_body`. `config.noIdempotencyCapture` makes the middleware stand aside:
 * no claim, no stored response, and a replay RE-RUNS the handler (double-submit safety is the route's own
 * precondition, e.g. `expectedCurrentGeneration`).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";
const SECRET = "WXB1.SECRETSECRETSECRETSECRET00.ABCD";

describe("applyIdempotency -- config.noIdempotencyCapture", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  async function build() {
    const store = createInMemoryIdempotencyStore();
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = { organizationId: ORG };
    });
    applyErrorHandler(app);
    applyIdempotency(app, store);
    let runs = 0;
    app.post("/secret", { config: { noIdempotencyCapture: true } }, async (_request, reply) => {
      runs += 1;
      return reply.code(201).send({ payload: SECRET, run: runs });
    });
    app.post("/plain", async (_request, reply) => {
      runs += 1;
      return reply.code(201).send({ run: runs });
    });
    await app.ready();
    return { store, runs: () => runs };
  }

  const post = (url: string, key: string) =>
    app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload: { a: 1 } });

  it("never stores the response of an opted-out route, even when the client sent a key", async () => {
    const { store } = await build();
    const res = await post("/secret", "key-secret");
    expect(res.statusCode).toBe(201);
    expect(res.json().payload).toBe(SECRET);
    expect(await store.load(ORG, "key-secret")).toBeNull();
  });

  it("a replay of an opted-out route re-runs the handler instead of replaying a cached secret", async () => {
    const { runs } = await build();
    await post("/secret", "key-secret");
    const again = await post("/secret", "key-secret");
    expect(again.statusCode).toBe(201);
    expect(runs()).toBe(2);
  });

  it("leaves every other route's idempotency untouched", async () => {
    const { store, runs } = await build();
    await post("/plain", "key-plain");
    const replay = await post("/plain", "key-plain");
    expect(replay.json()).toEqual({ run: 1 });
    expect(runs()).toBe(1);
    expect(await store.load(ORG, "key-plain")).toMatchObject({ state: "complete" });
  });
});
