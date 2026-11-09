// apps/backend/src/bootstrap/plugins/idempotency.ts — M1 idempotency HTTP middleware
// (spec §4.6 / W-M1-10 / SEC-025; M1-T10).
//
// This is the HTTP wrapper the `@chartwarden/shared` idempotency helper's docstring promised
// "is wired in M1-T10": it reuses that leaf's request fingerprint (computeIdempotencyHash
// = HMAC-SHA-256 over scope + key + body under a server key, the scope being org, user, actor kind, method,
// route template, path params, query string and `If-Match`) and its injected IdempotencyStore port (Valkey /
// Postgres `idempotency_key`), so the HTTP layer adds NO direct schema write. The fingerprint is
// KEYED because a body can be a credential and the table must not hold something a reader can test
// guesses against; the key is derived from BETTER_AUTH_SECRET (see `idempotencyHmacKey`).
//
// Contract (spec §4.6): only guards mutating methods carrying an `Idempotency-Key`; skips
// unauthenticated routes (no org scope to key on). A first request records a `pending`
// lock then captures its response on the way out (onSend) and marks it `complete`. A replay
// with the SAME body returns the cached response; a DIFFERENT body is a 409
// IDEMPOTENCY_CONFLICT (a record written under another server key, i.e. after a secret rotation, is a 409 IDEMPOTENCY_KEY_STALE); a concurrent duplicate still in flight is a 409 CONFLICT.
import { createHmac, randomBytes } from "node:crypto";
import {
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentResponse,
  claimIdempotencyKey,
  computeIdempotencyHash,
  legacyIdempotencyHash,
} from "@chartwarden/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { reservedPlaceholderProblem } from "../env";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Opt this route out of `Idempotency-Key` capture. For a response that carries a one-time secret
     * (GAP-020: the wristband token): it must never reach `idempotency_key.response_body`.
     */
    noIdempotencyCapture?: boolean;
  }
}

/** Per-request marker: a `pending` lock this request opened and must `complete` on send. */
const pendingCaptures = new WeakMap<FastifyRequest, { orgId: string; key: string }>();

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/** Domain separation: this key is for request fingerprints only, whatever else BETTER_AUTH_SECRET keys. */
const FINGERPRINT_KEY_LABEL = "chartwarden:idempotency:request-fingerprint:v1";
const MIN_SECRET_LENGTH = 32;

/**
 * The server key the request fingerprint is an HMAC under: HMAC-SHA-256(BETTER_AUTH_SECRET, purpose label). It must be the same on
 * every replica and across restarts (an Idempotency-Key is replayed up to 24 h later), so it comes from configuration the platform
 * already requires, never a constant in the code. Production refuses to boot without it. Outside production a missing secret gets a
 * process-local random key: nothing is replayable across a restart there, which only costs a dev a clean 409. Rotating the secret
 * makes every stored fingerprint a clean mismatch (409 IDEMPOTENCY_KEY_STALE), never a replay and never a re-run.
 */
export function idempotencyHmacKey(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (message: string) => void,
): Buffer {
  // Trimmed, like the production env gate (assertProductionEnv trims before it checks), so the key is derived from the very
  // value that gate validated; and held to its rules: at least 32 characters AFTER the trim, and no RFC 2606 reserved host in it
  // (the env gate's placeholder rule, reused: it is a HOST check, so a placeholder that is not a host is not recognised here, as it
  // is not by the gate). A weak secret outside production is not used: a process-local random key, announced once through `warn`.
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  const placeholder = reservedPlaceholderProblem(secret);
  if (secret.length >= MIN_SECRET_LENGTH && placeholder === null) {
    return createHmac("sha256", secret).update(FINGERPRINT_KEY_LABEL).digest();
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      `BETTER_AUTH_SECRET (at least ${MIN_SECRET_LENGTH} characters, trimmed${placeholder === null ? "" : `; ${placeholder}`}) is required in production: it keys the Idempotency-Key request fingerprint`,
    );
  }
  // Never the secret's value in the line: only that it was unusable.
  warn?.(PROCESS_LOCAL_KEY_WARNING);
  return randomBytes(32);
}

const PROCESS_LOCAL_KEY_WARNING =
  "BETTER_AUTH_SECRET is missing, shorter than 32 characters after the trim, or contains a reserved placeholder host: the Idempotency-Key fingerprint uses a process-local random key, so a retry that reaches another process, or one made after a restart, answers 409 IDEMPOTENCY_KEY_STALE (production refuses to boot in this state)";

export interface ApplyIdempotencyOptions {
  /** The fingerprint's HMAC key. Default: {@link idempotencyHmacKey} over the process environment. */
  readonly hmacKey?: string | Uint8Array;
}

export function applyIdempotency(
  app: FastifyInstance,
  store: IdempotencyStore,
  options: ApplyIdempotencyOptions = {},
): void {
  const hmacKey =
    options.hmacKey ?? idempotencyHmacKey(process.env, (message) => app.log.warn(message));
  if (hmacKey.length === 0) {
    // an empty key would sign every fingerprint under nothing: refuse it instead of quietly weakening the HMAC
    throw new Error("the Idempotency-Key fingerprint HMAC key must not be empty");
  }
  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    // A route that returns a ONE-TIME SECRET (GAP-020: the wristband token) opts out: its response must never be
    // copied into `idempotency_key.response_body`, even though the shared web client sends a key on every mutation.
    // It has no pending claim, so `onSend` below captures nothing. Its double-submit safety is its own precondition.
    if (request.routeOptions?.config?.noIdempotencyCapture === true) return;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length === 0) return;
    const orgId = request.context?.organizationId;
    if (!orgId) return; // unauthenticated route — nothing to scope the key by

    // The fingerprint binds WHO asks (org + user + actor kind) and WHAT is asked (method, the matched route template, its
    // path parameters, the query string, the `If-Match` version) as well as the key and body. A key reused by a different
    // user in the same org, by an `ai_*` principal that shares a user id with a human, or aimed at a different tenant slug /
    // resource id / method / route, or with another query string (it selects what a handler does), or retried with another
    // version, is a conflict (409), never a replay of the first request's cached response (which for e.g. a billing override
    // echoes the typed rationale, and for a 428 would keep answering "version missing" to a retry that now sends it). It is
    // answered before any route-level permission guard runs, so the actor kind must be in the fingerprint: a guard that
    // refuses an AI principal never gets to run on a replay. JSON-encoded, so no field can bleed into its neighbour.
    const actorKind = request.context?.attributes?.actorKind;
    const scope = JSON.stringify([
      orgId,
      request.context?.userId ?? "",
      typeof actorKind === "string" && actorKind.length > 0 ? actorKind : "user",
      request.method,
      request.routeOptions?.url ?? "",
      request.params ?? null,
      request.query ?? null,
      request.headers["if-match"] ?? null,
    ]);
    const requestHash = computeIdempotencyHash(scope, key, request.body ?? null, hmacKey);
    // The shared claim (`@chartwarden/shared` claimIdempotencyKey, the core of runIdempotent) decides: a cached
    // response replays (a record stored before the keyed hash still matches the same request, so a retry across the deploy
    // replays), a different body is 409 IDEMPOTENCY_CONFLICT, a record under another server key (a rotated secret) is
    // 409 IDEMPOTENCY_KEY_STALE, a duplicate still in flight is 409 CONFLICT.
    // The legacy arm is chosen from the STORED record (no `h1:` prefix), never from anything the request says. What it matches is
    // what origin/main's middleware wrote: the plain SHA-256 of `${orgId}|${userId}` (as the scope), key and body, and nothing
    // else (no method, route, params, query string or If-Match). Good enough for the 24 h a pre-deploy row lives: a retry of a
    // pre-deploy request replays, another body or another user is a 409, and nothing is ever re-run.
    // REMOVAL: remove this arm and `legacyIdempotencyHash` after 2026-11-16, once every environment has passed one TTL after deploy.
    const legacyScope = `${orgId}|${request.context?.userId ?? ""}`;
    const cached = await claimIdempotencyKey(store, orgId, key, requestHash, () =>
      legacyIdempotencyHash(legacyScope, key, request.body ?? null),
    );
    if (cached) return reply.code(Number(cached.status) || 200).send(cached.body);
    pendingCaptures.set(request, { orgId, key });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const marker = pendingCaptures.get(request);
    if (!marker) return payload;
    pendingCaptures.delete(request);
    const response: IdempotentResponse = {
      status: String(reply.statusCode),
      body: parsePayload(payload),
    };
    // BOOKKEEPING MUST NOT REWRITE THE OUTCOME (F-073, #182). By `onSend` the handler has already
    // COMMITTED; letting a store error escape turns a write that happened into a 500 that says it
    // did not — which is exactly what a bodiless 204 did on the production store, verified live: the
    // row was gone and the UI reported failure. Worse, the client mints a fresh key per request, so
    // the user's retry runs under a NEW key and re-executes — the mechanism that exists to prevent
    // double-execution causing it.
    //
    // The failure is logged, never swallowed silently, and the record is left `pending`: a retry
    // under the SAME key then answers 409 rather than re-running, so duplicate prevention still
    // fails safe. Reporting the truth about the write is the property worth keeping here.
    try {
      await store.complete(marker.orgId, marker.key, response);
    } catch (error) {
      request.log.error(
        { err: error, idempotencyKey: marker.key },
        "idempotency: could not record the completed response; the write itself succeeded and the key stays pending",
      );
    }
    return payload;
  });
}

/** How long an in-memory record stays replayable; mirrors the Postgres store's TTL (§3.10). */
const IN_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

export interface InMemoryIdempotencyStoreOptions {
  readonly ttlMs?: number;
  /** Injectable clock (epoch ms) so expiry is testable without sleeping. */
  readonly now?: () => number;
}

/**
 * In-memory IdempotencyStore — the slice default (single instance). `putPending` is the atomic
 * claim (check-and-set with no await between), so concurrent duplicates serialize: exactly one
 * caller gets `true`. An expired record is absent to `load` and is reclaimed by `putPending`.
 * Production injects the Postgres-backed store with the same contract. Exported for boot wiring + tests.
 */
export function createInMemoryIdempotencyStore(
  options: InMemoryIdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? IN_MEMORY_TTL_MS;
  const now = options.now ?? Date.now;
  type Entry = { record: IdempotencyRecord; expiresAt: number };
  const entries = new Map<string, Entry>();
  const k = (orgId: string, key: string) => `${orgId} ${key}`;
  const live = (orgId: string, key: string): Entry | undefined => {
    const entry = entries.get(k(orgId, key));
    return entry && entry.expiresAt > now() ? entry : undefined;
  };
  return {
    async load(orgId, key) {
      return live(orgId, key)?.record ?? null;
    },
    async putPending(orgId, key, requestHash) {
      if (live(orgId, key)) return false;
      entries.set(k(orgId, key), {
        record: { state: "pending", requestHash },
        expiresAt: now() + ttlMs,
      });
      return true;
    },
    async complete(orgId, key, response) {
      const existing = live(orgId, key);
      // Only the claim holder completes a pending record (mirrors the Postgres store's narrowing).
      if (existing?.record.state !== "pending") return;
      entries.set(k(orgId, key), {
        record: { state: "complete", requestHash: existing.record.requestHash, response },
        expiresAt: existing.expiresAt,
      });
    },
  };
}
