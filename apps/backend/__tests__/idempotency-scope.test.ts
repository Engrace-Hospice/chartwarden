/**
 * The Idempotency-Key fingerprint must bind WHAT is being asked, not only who asks and with which body: the same key
 * and body sent to a different tenant slug / resource id / method / route is a different request, so it is a 409
 * IDEMPOTENCY_CONFLICT and never a replay of the first request's cached response (which for the platform onboarding
 * routes would hand tenant B's response back to a call aimed at tenant D). The `If-Match` version is part of the
 * request too: a retry that adds it must not replay the cached 428 that said it was missing.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

describe("applyIdempotency fingerprint scope", () => {
  let app: FastifyInstance;
  let runs: Record<string, number>;
  afterEach(async () => {
    await app?.close();
  });

  async function build() {
    runs = {};
    const count = (name: string) => {
      runs[name] = (runs[name] ?? 0) + 1;
      return runs[name];
    };
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = { organizationId: ORG, userId: USER };
    });
    applyErrorHandler(app);
    applyIdempotency(app, createInMemoryIdempotencyStore());
    app.post("/tenants/:slug/items", async (request, reply) =>
      reply.code(201).send({ via: "post", slug: (request.params as { slug: string }).slug, run: count("post") }),
    );
    app.patch("/tenants/:slug/items", async (request, reply) =>
      reply.code(200).send({ via: "patch", slug: (request.params as { slug: string }).slug, run: count("patch") }),
    );
    app.post("/tenants/:slug/other", async (_request, reply) =>
      reply.code(201).send({ via: "other", run: count("other") }),
    );
    app.post("/versioned", async (request, reply) => {
      count("versioned");
      if (request.headers["if-match"] === undefined) {
        return reply.code(428).send({ error: { code: "IF_MATCH_REQUIRED" } });
      }
      return reply.code(200).send({ ok: true });
    });
    await app.ready();
  }

  const send = (
    method: "POST" | "PATCH",
    url: string,
    headers: Record<string, string> = {},
    payload: unknown = { a: 1 },
  ) =>
    app.inject({
      method,
      url,
      headers: { "idempotency-key": "k-1", ...headers },
      payload: payload as object,
    });
  const conflictCode = (res: { json: () => { error?: { code?: string } } }) =>
    res.json().error?.code;

  it("still replays the identical request (same method, route, params, body, key)", async () => {
    await build();
    const first = await send("POST", "/tenants/b/items");
    const replay = await send("POST", "/tenants/b/items");
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(runs.post).toBe(1);
  });

  it("the same key and body for a DIFFERENT path parameter is a 409, never the first response", async () => {
    await build();
    await send("POST", "/tenants/b/items");
    const other = await send("POST", "/tenants/d/items");
    expect(other.statusCode).toBe(409);
    expect(conflictCode(other)).toBe("IDEMPOTENCY_CONFLICT");
    expect(other.body).not.toContain('"slug":"b"');
    expect(runs.post).toBe(1);
  });

  it("the same key and body for a different METHOD on the same URL is a 409", async () => {
    await build();
    await send("POST", "/tenants/b/items");
    const patch = await send("PATCH", "/tenants/b/items");
    expect(patch.statusCode).toBe(409);
    expect(conflictCode(patch)).toBe("IDEMPOTENCY_CONFLICT");
    expect(runs.patch).toBeUndefined();
  });

  it("the same key and body for a different ROUTE is a 409", async () => {
    await build();
    await send("POST", "/tenants/b/items");
    const other = await send("POST", "/tenants/b/other");
    expect(other.statusCode).toBe(409);
    expect(conflictCode(other)).toBe("IDEMPOTENCY_CONFLICT");
    expect(runs.other).toBeUndefined();
  });

  it("an If-Match retry does not replay the cached 428; a different If-Match is a different request", async () => {
    await build();
    const missing = await send("POST", "/versioned");
    expect(missing.statusCode).toBe(428);
    const retry = await send("POST", "/versioned", { "if-match": '"3"' });
    expect(retry.statusCode).toBe(409);
    expect(conflictCode(retry)).toBe("IDEMPOTENCY_CONFLICT");
    expect(runs.versioned).toBe(1);
    // ...while a retry of the SAME version replays
    const first = await send("POST", "/versioned", { "idempotency-key": "k-2", "if-match": '"3"' });
    const same = await send("POST", "/versioned", { "idempotency-key": "k-2", "if-match": '"3"' });
    expect(same.statusCode).toBe(first.statusCode);
    expect(runs.versioned).toBe(2);
    const changed = await send("POST", "/versioned", { "idempotency-key": "k-2", "if-match": '"4"' });
    expect(changed.statusCode).toBe(409);
  });
});
