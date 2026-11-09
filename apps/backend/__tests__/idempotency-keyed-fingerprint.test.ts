/**
 * The Idempotency-Key request fingerprint is stored in `idempotency_key.request_hash`, and the body it covers can be a credential
 * (a clinic key, a clearinghouse secret). A plain SHA-256 there lets anyone who can read the table test guesses for the secret
 * offline, so the fingerprint is an HMAC under a server key derived from BETTER_AUTH_SECRET: not testable without it.
 *
 * Also proved: a record written BEFORE the deploy (the plain SHA-256 origin/main's middleware wrote, no `h1:` prefix) still
 * replays the same request and still conflicts on another body or another user, so a retry across the deploy is not re-executed; a
 * record under another server key is a clean 409; and production refuses to boot without a real secret.
 */
import { createHash } from "node:crypto";
import type { IdempotencyStore } from "@chartwarden/shared";
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
const OTHER_USER = "00000000-0000-4000-8000-0000000000bb";
const SECRET_BODY = { clinicKey: "a-guessable-clinic-key-1234" };

/**
 * origin/main's request fingerprint, copied from before the keyed hash (packages/shared computeIdempotencyHash): the plain SHA-256 of
 * JSON({organizationId, key, body}). Its middleware called it with the scope `${orgId}|${userId}` as the organizationId argument, so a
 * row written before this deploy binds org, user, key and body, and NOTHING else (no method, route, params, query string, If-Match).
 */
const mainsComputeIdempotencyHash = (organizationId: string, key: string, body: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify({ organizationId, key, body: body ?? null }))
    .digest("hex");
const mainsMiddlewareHash = (org: string, user: string, key: string, body: unknown): string =>
  mainsComputeIdempotencyHash(`${org}|${user}`, key, body);

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
      const user = request.headers["x-test-user"];
      const actorKind = request.headers["x-test-actor-kind"];
      (request as unknown as { context: unknown }).context = {
        organizationId: ORG,
        userId: typeof user === "string" ? user : USER,
        attributes: typeof actorKind === "string" ? { actorKind } : {},
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, store, { hmacKey });
    app.post("/secrets", async (_request, reply) => {
      runs += 1;
      return reply.code(201).send({ run: runs });
    });
    await app.ready();
  }
  const post = (body: unknown, key = "k-1", headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/secrets",
      headers: { "idempotency-key": key, ...headers },
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
    expect(stored).toMatch(/^h1:[0-9a-f]{8}:[0-9a-f]{64}$/);
    // what an attacker with table access can compute for a candidate body (the old scheme) is NOT what is stored
    expect(stored).not.toContain(mainsMiddlewareHash(ORG, USER, "k-1", SECRET_BODY));
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

  describe("a record origin/main wrote before the keyed hash (plain SHA-256, no `h1:` prefix)", () => {
    /** Seeds what main's middleware stored for a completed request, then builds the app over it. */
    async function seedMainsRecord(user: string = USER) {
      const inner = createInMemoryIdempotencyStore();
      const legacy = mainsMiddlewareHash(ORG, user, "k-1", SECRET_BODY);
      expect(legacy).toMatch(/^[0-9a-f]{64}$/);
      await inner.putPending(ORG, "k-1", legacy);
      await inner.complete(ORG, "k-1", { status: "201", body: { run: "before-the-deploy" } });
      await build(inner);
    }

    it("replays the same request (same org, user, key and body): the handler never runs", async () => {
      await seedMainsRecord();
      const replay = await post(SECRET_BODY);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual({ run: "before-the-deploy" });
      expect(runs).toBe(0);
    });

    it("conflicts on another body, and on another USER (the user is part of what main hashed)", async () => {
      await seedMainsRecord();
      const otherBody = await post({ clinicKey: "a-different-clinic-key-5678" });
      expect(otherBody.statusCode).toBe(409);
      expect(otherBody.json().error?.code).toBe("IDEMPOTENCY_CONFLICT");
      const otherUser = await post(SECRET_BODY, "k-1", { "x-test-user": OTHER_USER });
      expect(otherUser.statusCode).toBe(409);
      expect(otherUser.json().error?.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(runs).toBe(0);
    });

    it("a keyed record never falls back to the plain hash: the same body and user under another actor kind is a conflict (defensive: the prefix check itself is pinned in packages/shared)", async () => {
      // a keyed record never falls back to the plain hash: same user and body under a changed scope is a conflict
      const records = recordingStore();
      await build(records.store);
      await post(SECRET_BODY);
      const sameBodyOtherActorKind = await post(SECRET_BODY, "k-1", {
        "x-test-actor-kind": "ai_x",
      });
      expect(sameBodyOtherActorKind.statusCode).toBe(409);
      expect(runs).toBe(1);
    });
  });

  // Review of slice 4, L-c: this used to answer "reused with different body" for the SAME body, sending the client hunting for a body
  // difference that does not exist. It is its own 409, saying what happened and what to do.
  it("a record under ANOTHER server key (a rotated secret) is a 409 of its own (IDEMPOTENCY_KEY_STALE), never a replay and never a re-run", async () => {
    const first = recordingStore();
    await build(first.store, "an-earlier-server-key-000000000000002");
    await post(SECRET_BODY);
    await app.close();
    await build(first.inner, SERVER_KEY); // the same records, the key has changed
    const retry = await post(SECRET_BODY);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error?.code).toBe("IDEMPOTENCY_KEY_STALE");
    expect(retry.json().error?.message).toMatch(/new Idempotency-Key/);
    expect(retry.json().error?.message).not.toMatch(/different body/);
    expect(runs).toBe(0);
  });

  it("a different body is still IDEMPOTENCY_CONFLICT after the key changed back (only the key decides stale)", async () => {
    const records = recordingStore();
    await build(records.store);
    await post(SECRET_BODY);
    const other = await post({ clinicKey: "a-different-clinic-key-5678" });
    expect(other.statusCode).toBe(409);
    expect(other.json().error?.code).toBe("IDEMPOTENCY_CONFLICT");
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

  it("trims the secret: the key is the one the production env gate validated (it trims too)", () => {
    const padded = idempotencyHmacKey({
      BETTER_AUTH_SECRET: `  ${SECRET}\n`,
      NODE_ENV: "production",
    });
    expect(
      padded.equals(idempotencyHmacKey({ BETTER_AUTH_SECRET: SECRET, NODE_ENV: "production" })),
    ).toBe(true);
  });

  it("requires 32 characters on the TRIMMED value: a short secret padded with whitespace is a short secret", () => {
    const shortPadded = `${"s".repeat(31)}${" ".repeat(20)}`;
    expect(() =>
      idempotencyHmacKey({ NODE_ENV: "production", BETTER_AUTH_SECRET: shortPadded }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      idempotencyHmacKey({ NODE_ENV: "production", BETTER_AUTH_SECRET: " ".repeat(64) }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    // outside production a weak secret is not used: a process-local random key, never a key derived from 31 characters
    const a = idempotencyHmacKey({ NODE_ENV: "test", BETTER_AUTH_SECRET: shortPadded });
    const b = idempotencyHmacKey({ NODE_ENV: "test", BETTER_AUTH_SECRET: shortPadded });
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a secret that contains an RFC 2606 reserved host (the production env gate's placeholder rule: a HOST check, not a general placeholder check)", () => {
    const placeholder = "a-long-placeholder-secret-name.example.com";
    expect(placeholder.length).toBeGreaterThanOrEqual(32);
    expect(() =>
      idempotencyHmacKey({ NODE_ENV: "production", BETTER_AUTH_SECRET: placeholder }),
    ).toThrow(/placeholder|reserved/i);
  });

  it("refuses an injected EMPTY hmacKey: an empty key would sign every fingerprint under nothing", () => {
    for (const hmacKey of ["", new Uint8Array(0)]) {
      expect(() =>
        applyIdempotency(Fastify(), createInMemoryIdempotencyStore(), { hmacKey }),
      ).toThrow(/hmac key|must not be empty/i);
    }
  });

  describe("outside production, a missing or invalid secret is not silent", () => {
    const SHORT = "a-short-secret-value";
    const warnings = (vars: Record<string, string>): string[] => {
      const lines: string[] = [];
      idempotencyHmacKey({ NODE_ENV: "test", ...vars }, (message) => lines.push(message));
      return lines;
    };

    it.each([
      ["absent", {}],
      ["under 32 characters after the trim", { BETTER_AUTH_SECRET: `  ${"s".repeat(20)}  ` }],
      [
        "a reserved-host placeholder",
        { BETTER_AUTH_SECRET: "a-long-placeholder-secret-name.example.com" },
      ],
    ])(
      "warns ONCE when the secret is %s: the key is process-local, so a cross-process retry is IDEMPOTENCY_KEY_STALE",
      (_why, vars) => {
        const lines = warnings(vars);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/process-local/);
        expect(lines[0]).toMatch(/IDEMPOTENCY_KEY_STALE/);
      },
    );

    it("never puts the secret's value in the warning", () => {
      expect(warnings({ BETTER_AUTH_SECRET: SHORT }).join("\n")).not.toContain(SHORT);
    });

    it("says nothing when the secret is valid", () => {
      expect(warnings({ BETTER_AUTH_SECRET: SECRET })).toEqual([]);
    });

    it("applyIdempotency logs the warning once through the app's logger", async () => {
      const lines: string[] = [];
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("BETTER_AUTH_SECRET", "");
      const app = Fastify({
        logger: { level: "warn", stream: { write: (line: string) => lines.push(line) } },
      });
      applyIdempotency(app, createInMemoryIdempotencyStore());
      await app.close();
      expect(lines.filter((l) => /process-local/.test(l))).toHaveLength(1);
    });
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
