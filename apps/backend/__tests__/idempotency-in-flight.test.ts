/**
 * A duplicate that arrives while the first request with the same `Idempotency-Key` is still running used to be answered as
 * a plain `409 CONFLICT`, indistinguishable from a business-rule 409. A client that treats a 409 as "this key is spent, mint a
 * new one" would then renew the key while the first request is still writing, and the retry would write twice.
 *
 * It now has its own code, `IDEMPOTENCY_IN_FLIGHT` (status still 409, same standard envelope, same message), so a client can
 * keep its key and retry. This runs two concurrent identical requests through a real Fastify app with the real middleware.
 */
import { IDEMPOTENCY_PENDING_MAX_AGE_MS } from "@chartwarden/shared";
import { ConflictError, ERROR_CODES } from "@chartwarden/types";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";
const IN_FLIGHT_MESSAGE = "Idempotency-Key request is still being processed";

describe("a duplicate while the first request is still running", () => {
  let app: FastifyInstance;
  let runs = 0;
  let finishFirst: () => void = () => undefined;

  async function build(): Promise<void> {
    runs = 0;
    const firstMayFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        organizationId: ORG,
        correlationId: "cid-in-flight",
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, createInMemoryIdempotencyStore());
    app.post("/write", async (_request, reply) => {
      runs += 1;
      await firstMayFinish; // still running while the duplicate arrives
      return reply.code(201).send({ saved: true });
    });
    app.post("/conflict", async () => {
      throw new ConflictError("Business rule says no");
    });
    await app.ready();
  }

  afterEach(async () => {
    finishFirst();
    await app?.close();
  });

  /** Resolves once the first request is inside its handler, i.e. it holds the claim. */
  const firstHoldsClaim = async (): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (runs === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(runs).toBe(1);
  };

  const post = (url = "/write", key = "key-in-flight", payload: object = { a: 1 }) =>
    app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload });

  it("answers 409 IDEMPOTENCY_IN_FLIGHT in the standard envelope, and the handler runs once", async () => {
    await build();
    const first = post();
    await firstHoldsClaim();
    const duplicate = await post();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_IN_FLIGHT",
        message: IN_FLIGHT_MESSAGE,
        correlationId: "cid-in-flight",
        documentationUrl: "https://docs.chartwarden.app/errors/IDEMPOTENCY_IN_FLIGHT",
      },
    });
    finishFirst();
    expect((await first).statusCode).toBe(201);
    expect(runs).toBe(1);
  });

  it("the key stays usable: once the first request completes, the same key replays its response", async () => {
    await build();
    const first = post();
    await firstHoldsClaim();
    expect((await post()).json().error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
    finishFirst();
    await first;
    const replay = await post();
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual({ saved: true });
    expect(runs).toBe(1);
  });

  it("is told apart from the other 409s: a business conflict is CONFLICT, a reused key IDEMPOTENCY_CONFLICT", async () => {
    await build();
    expect((await post("/conflict", "key-business")).json().error.code).toBe("CONFLICT");
    const first = post();
    await firstHoldsClaim();
    const differentBody = await post("/write", "key-in-flight", { a: 2 });
    expect(differentBody.statusCode).toBe(409);
    expect(differentBody.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    finishFirst();
    await first;
  });

  it("the code is registered with the other error codes, as a 409", () => {
    expect(ERROR_CODES.IDEMPOTENCY_IN_FLIGHT).toBe(409);
  });
});

describe("a claim that never finishes does not loop a client on IDEMPOTENCY_IN_FLIGHT for ever", () => {
  let app: FastifyInstance;
  let clock = 1_000_000;
  let runs = 0;
  let finish: () => void = () => undefined;

  async function build(
    store = createInMemoryIdempotencyStore({ now: () => clock }),
  ): Promise<void> {
    runs = 0;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        organizationId: ORG,
        correlationId: "cid-stuck",
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, store);
    app.post("/write", async (_request, reply) => {
      runs += 1;
      await gate; // the first request never answers within the test: its claim stays pending
      return reply.code(201).send({ saved: true });
    });
    await app.ready();
  }

  afterEach(async () => {
    finish();
    await app?.close();
  });

  const post = (key = "key-stuck", payload: object = { a: 1 }) =>
    app.inject({ method: "POST", url: "/write", headers: { "idempotency-key": key }, payload });

  const waitForClaim = async (): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (runs === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(runs).toBe(1);
  };

  it("inside the bound a duplicate is IN_FLIGHT; past it the answer is IDEMPOTENCY_KEY_STUCK, and the row is never reclaimed or re-run", async () => {
    await build();
    const first = post();
    await waitForClaim();
    clock += IDEMPOTENCY_PENDING_MAX_AGE_MS - 1_000;
    expect((await post()).json().error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
    clock += 2_000; // now past the bound
    const stuck = await post();
    expect(stuck.statusCode).toBe(409);
    expect(stuck.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_STUCK",
        message: expect.stringMatching(
          /outcome is unknown.*do not retry with this key.*read the resource/is,
        ),
        correlationId: "cid-stuck",
        documentationUrl: "https://docs.chartwarden.app/errors/IDEMPOTENCY_KEY_STUCK",
      },
    });
    expect(Object.keys(stuck.json().error).sort()).toEqual([
      "code",
      "correlationId",
      "documentationUrl",
      "message",
    ]);
    // asking again changes nothing: still stuck, the handler ran once, and nothing was reclaimed
    expect((await post()).json().error.code).toBe("IDEMPOTENCY_KEY_STUCK");
    expect(runs).toBe(1);
    // a different body under the stuck key is still a reused-key conflict
    expect((await post("key-stuck", { a: 2 })).json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    // another key is unaffected
    finish();
    expect((await first).statusCode).toBe(201);
  });

  it("the code is registered as a 409 with the others", () => {
    expect(ERROR_CODES.IDEMPOTENCY_KEY_STUCK).toBe(409);
  });
});
