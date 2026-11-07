/**
 * The Idempotency-Key request fingerprint is stored in `idempotency_key.request_hash`, and the body it covers can be a credential
 * (a clinic key, a clearinghouse secret). A plain SHA-256 there lets anyone who can read the table test guesses for the secret
 * offline, so the fingerprint is an HMAC under a server key derived from BETTER_AUTH_SECRET: not testable without it.
 *
 * Also proved: a record written BEFORE the deploy (plain SHA-256, no `h1:` prefix) still replays the same request and still
 * conflicts on another body, so a retry across the deploy is not re-executed; a record under another server key is a clean 409; and
 * production refuses to boot without the secret.
 */
import { createHash } from "node:crypto";
import { type IdempotencyStore, legacyIdempotencyHash } from "@chartwarden/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
  idempotencyHmacKey,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SERVER_KEY = "server-side-fingerprint-key-for-tests-0001";
const SECRET_BODY = { clinicKey: "a-guessable-clinic-key-1234" };
/** The scope the middleware binds (org, user, method, route template, params, If-Match): the legacy hash was taken over it. */
const SCOPE = JSON.stringify([ORG, USER, "POST", "/secrets", {}, null]);

describe("the Idempotency-Key fingerprint is keyed", () => {
  let app: FastifyInstance;
  let runs = 0;
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  async function build(store: IdempotencyStore, hmacKey: string = SERVER_KEY) {
    runs = 0;
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = { organizationId: ORG, userId: USER };
    });
    applyErrorHandler(app);
    applyIdempotency(app, store, { hmacKey });
    app.post("/secrets", async (_request, reply) => {
      runs += 1;
      return reply.code(201).send({ run: runs });
    });
    await app.ready();
  }
  const post = (body: unknown, key = "k-1") =>
    app.inject({
      method: "POST",
      url: "/secrets",
      headers: { "idempotency-key": key },
      payload: body as object,
    });

  /** A store that lets the test see (and seed) exactly what the middleware persists. */
  function recordingStore() {
    const inner = createInMemoryIdempotencyStore();
    const claimed: string[] = [];
    const store: IdempotencyStore = {
      load: (o, k) => inner.load(o, k),
      putPending: async (o, k, requestHash) => {
        claimed.push(requestHash);
        return inner.putPending(o, k, requestHash);
      },
      complete: (o, k, r) => inner.complete(o, k, r),
    };
    return { store, inner, claimed };
  }

  it("stores a keyed `h1:` HMAC, never the plain SHA-256 of the request, and nothing of the secret", async () => {
    const { store, claimed } = recordingStore();
    await build(store);
    expect((await post(SECRET_BODY)).statusCode).toBe(201);
    expect(claimed).toHaveLength(1);
    const stored = claimed[0] as string;
    expect(stored).toMatch(/^h1:[0-9a-f]{64}$/);
    // what an attacker with table access can compute for a candidate body (the old scheme) is NOT what is stored
    expect(stored).not.toContain(legacyIdempotencyHash(SCOPE, "k-1", SECRET_BODY));
    expect(stored).not.toContain(
      createHash("sha256").update(JSON.stringify(SECRET_BODY)).digest("hex"),
    );
    expect(stored).not.toContain("guessable");
  });

  it("still replays the identical request and still refuses a different body under the same key", async () => {
    await build(createInMemoryIdempotencyStore());
    const first = await post(SECRET_BODY);
    const again = await post(SECRET_BODY);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(runs).toBe(1);
    const other = await post({ clinicKey: "a-different-clinic-key-5678" });
    expect(other.statusCode).toBe(409);
    expect(other.json().error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(runs).toBe(1);
  });

  it("a record written before the keyed hash (plain SHA-256) still replays the same request and conflicts on another: a retry across the deploy is not re-executed", async () => {
    const inner = createInMemoryIdempotencyStore();
    const legacy = legacyIdempotencyHash(SCOPE, "k-1", SECRET_BODY);
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    await inner.putPending(ORG, "k-1", legacy);
    await inner.complete(ORG, "k-1", { status: "201", body: { run: "before-the-deploy" } });
    await build(inner);
    const replay = await post(SECRET_BODY);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual({ run: "before-the-deploy" });
    expect(runs).toBe(0); // the handler never ran
    expect((await post({ clinicKey: "a-different-clinic-key-5678" })).statusCode).toBe(409);
    expect(runs).toBe(0);
  });

  it("a record under ANOTHER server key (a rotated secret) is a clean 409, never a replay and never a re-run", async () => {
    const first = recordingStore();
    await build(first.store, "an-earlier-server-key-000000000000002");
    await post(SECRET_BODY);
    await app.close();
    await build(first.inner, SERVER_KEY); // the same records, the key has changed
    const retry = await post(SECRET_BODY);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(runs).toBe(0);
  });
});

describe("the server key", () => {
  const SECRET = "better-auth-secret-of-at-least-32-characters-0001";

  it("is derived from BETTER_AUTH_SECRET under a purpose label: stable, 32 bytes, and not the secret itself", () => {
    const a = idempotencyHmacKey({ BETTER_AUTH_SECRET: SECRET, NODE_ENV: "production" });
    const b = idempotencyHmacKey({ BETTER_AUTH_SECRET: SECRET, NODE_ENV: "production" });
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    expect(a.toString("utf8")).not.toContain(SECRET);
    expect(
      a.equals(idempotencyHmacKey({ BETTER_AUTH_SECRET: `${SECRET}x`, NODE_ENV: "production" })),
    ).toBe(false);
  });

  it("production refuses to boot without the secret (or with a short one)", () => {
    expect(() => idempotencyHmacKey({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      idempotencyHmacKey({ NODE_ENV: "production", BETTER_AUTH_SECRET: "too-short" }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("outside production a missing secret gets a process-local random key (never a constant in the code)", () => {
    const a = idempotencyHmacKey({ NODE_ENV: "test" });
    const b = idempotencyHmacKey({ NODE_ENV: "test" });
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });

  it("applyIdempotency with no explicit key takes it from the environment", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const app = Fastify();
    applyIdempotency(app, createInMemoryIdempotencyStore());
    await app.close();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => applyIdempotency(Fastify(), createInMemoryIdempotencyStore())).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});
