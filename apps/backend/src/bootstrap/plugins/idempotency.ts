// apps/backend/src/bootstrap/plugins/idempotency.ts — M1 idempotency HTTP middleware
// (spec §4.6 / W-M1-10 / SEC-025; M1-T10).
//
// This is the HTTP wrapper the `@chartwarden/shared` idempotency helper's docstring promised
// "is wired in M1-T10": it reuses that leaf's request fingerprint (computeIdempotencyHash
// = SHA-256 over scope + key + body, the scope being org, user, actor kind, method, route template,
// path params, query string and `If-Match`) and its injected IdempotencyStore port (Valkey /
// Postgres `idempotency_key`), so the HTTP layer adds NO direct schema write.
//
// Contract (spec §4.6): only guards mutating methods carrying an `Idempotency-Key`; skips
// unauthenticated routes (no org scope to key on). A first request records a `pending`
// lock then captures its response on the way out (onSend) and marks it `complete`. A replay
// with the SAME body returns the cached response; a DIFFERENT body is a 409
// IDEMPOTENCY_CONFLICT; a concurrent duplicate still in flight is a 409 IDEMPOTENCY_IN_FLIGHT (its own code, so a client keeps its
// key and retries instead of renewing it while the first request is still writing).
//
// RETRYABLE FAILURES (a 5xx, or the deadlock/serialization 409 CONCURRENT_UPDATE) are released instead of cached, but ONLY when
// the request provably committed nothing. A response that says "retry" is true only if no write of this request is durable: a
// handler whose transaction committed and which then failed (a throwing post-commit step, a response the serializer refuses, a
// second transaction that deadlocks after the first committed) HAS written, and re-running it on a same-key retry would write
// twice. So the outcome is cached and replayed as before (the safe direction) whenever the per-request commit tracker
// (`@chartwarden/db` commit-tracker.ts, fed by the pool every query goes through) saw a write commit, or may have, after the
// claim; whenever a write of this request is still open (a transaction that has written but not issued COMMIT yet, e.g. one half
// of a Promise.all while the other half failed) or unanswered; and whenever there is no tracker to ask or the ambient one is not
// this request's (the async context was lost, so its writes were not seen). A SELECT that calls a function counts as a write
// unless the function is a known read-only builtin. Released, the same key runs again once the store is reachable; if the
// release itself fails (a database outage that caused the 5xx usually breaks it too) the key stays `pending` and a retry
// answers 409 in flight until the record's 24h TTL ends. What the tracker cannot see (an outbound call, a queue or object-store
// write made directly in a route) is not counted: those belong behind the outbox, after the commit.
import {
  createCommitTracker,
  currentCommitTracker,
  mayHaveCommitted,
  resetCommitTracker,
  runWithCommitTracker,
} from "@chartwarden/db";
import type { CommitTracker } from "@chartwarden/db";
import {
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentResponse,
  claimIdempotencyKey,
  computeIdempotencyHash,
} from "@chartwarden/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Opt this route out of `Idempotency-Key` capture. For a response that carries a one-time secret
     * (GAP-020: the wristband token): it must never reach `idempotency_key.response_body`.
     */
    noIdempotencyCapture?: boolean;
  }
}

/** Per-request marker: a `pending` lock this request opened and must `complete` (or `release`) on send. */
const pendingCaptures = new WeakMap<
  FastifyRequest,
  { orgId: string; key: string; requestHash: string }
>();

/** The error code of the retryable deadlock/serialization 409 (error-handler.ts): "this step was not applied; check, then retry". */
const RETRYABLE_CONFLICT_CODE = "CONCURRENT_UPDATE";

/** The per-request commit trackers: opened in `onRequest` (so the ambient store covers the whole request), read in `onSend`. */
const commitTrackers = new WeakMap<FastifyRequest, CommitTracker>();

/**
 * A response that SAYS the write did not happen and the client should run it again — any 5xx, and the retryable
 * deadlock/serialization 409. Replaying it for the 24h TTL would turn "retry" into "never" when the write really did not run;
 * these are released instead of completed, but only if the request also committed nothing (see the header).
 */
function isRetryableOutcome(statusCode: number, body: unknown): boolean {
  if (statusCode >= 500) return true;
  if (statusCode !== 409 || typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === RETRYABLE_CONFLICT_CODE
  );
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export function applyIdempotency(app: FastifyInstance, store: IdempotencyStore): void {
  // Open the commit tracker for a request that can be claimed (a mutating method carrying a key). The callback form of `done`
  // keeps the ambient store active across every later hook, the handler, the serializer and `onSend` (the request-context
  // plugin relies on the same). Other requests, reads included, are not tracked and pay nothing.
  app.addHook("onRequest", (request, _reply, done) => {
    const key = request.headers["idempotency-key"];
    if (request.method === "GET" || request.method === "HEAD") return done();
    if (typeof key !== "string" || key.length === 0) return done();
    const tracker = createCommitTracker();
    commitTrackers.set(request, tracker);
    runWithCommitTracker(tracker, () => done());
  });

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
    const requestHash = computeIdempotencyHash(scope, key, request.body ?? null);
    // The shared claim (`@chartwarden/shared` claimIdempotencyKey, the core of runIdempotent) decides: a cached
    // response replays, a different body is 409 IDEMPOTENCY_CONFLICT, a duplicate still in flight is 409 IDEMPOTENCY_IN_FLIGHT.
    const cached = await claimIdempotencyKey(store, orgId, key, requestHash);
    if (cached) return reply.code(Number(cached.status) || 200).send(cached.body);
    // Only what commits AFTER the claim is the write the key guards (authentication may touch a session row before it).
    const tracker = commitTrackers.get(request);
    if (tracker) {
      resetCommitTracker(tracker);
      // The pool attributes writes to the AMBIENT tracker. If the async context was lost between `onRequest` and here (or holds
      // another request's), nothing this request writes would reach `tracker`, which would stay clean and every 5xx would be
      // released. Fail closed: a request whose context is not its own tracker is treated as committed (cached). Logged, so a
      // runtime that drops the context shows up as warnings instead of as silently unreleasable keys.
      if (currentCommitTracker() !== tracker) {
        tracker.committed = true;
        request.log.warn(
          { idempotencyKey: key },
          "idempotency: the request's commit tracker is not the ambient one; its failures will be cached, not released",
        );
      }
    }
    pendingCaptures.set(request, { orgId, key, requestHash });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const marker = pendingCaptures.get(request);
    if (!marker) return payload;
    pendingCaptures.delete(request);
    const response: IdempotentResponse = {
      status: String(reply.statusCode),
      body: parsePayload(payload),
    };
    const tracker = commitTrackers.get(request);
    // No tracker to ask means no proof that nothing committed: cache (never release). The same when the ambient tracker is not
    // this request's: the context was lost somewhere after the claim, so the writes of the handler were not seen either. And the
    // same while a write of this request is still open or unanswered (one half of a Promise.all that has not committed YET, a
    // transaction still running behind a 503 deadline): its COMMIT would land under a freed key.
    const retryable = isRetryableOutcome(reply.statusCode, response.body);
    const ownsContext = tracker !== undefined && currentCommitTracker() === tracker;
    const provablyUncommitted = tracker !== undefined && !mayHaveCommitted(tracker) && ownsContext;
    if (retryable && tracker !== undefined && !ownsContext) {
      request.log.warn(
        { idempotencyKey: marker.key, statusCode: reply.statusCode },
        "idempotency: the async context was lost before the response; a retryable failure is cached, not released",
      );
    }
    if (provablyUncommitted && retryable) {
      // Nothing of this request committed, so "retry" is true: free the key so the same-key retry runs instead of replaying
      // the failure. A failed release leaves the record `pending` (a retry answers 409 in flight until the record's TTL), the
      // same fail-safe as a failed `complete`; it is logged, never allowed to rewrite the response.
      try {
        await store.release(marker.orgId, marker.key, marker.requestHash);
      } catch (error) {
        request.log.error(
          { err: error, idempotencyKey: marker.key },
          "idempotency: could not release the claim after a retryable failure; the key stays pending",
        );
      }
      return payload;
    }
    // BOOKKEEPING MUST NOT REWRITE THE OUTCOME (F-073, #182). By `onSend` the handler has already
    // COMMITTED (and a retryable-looking failure that reaches this line is cached because it did too, or because nothing can
    // prove it did not); letting a store error escape turns a write that happened into a 500 that says it
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
    async release(orgId, key, requestHash) {
      // Only the claimant's own pending record goes (same hash, still pending); never a completed response.
      const existing = live(orgId, key);
      if (existing?.record.state !== "pending" || existing.record.requestHash !== requestHash) {
        return;
      }
      entries.delete(k(orgId, key));
    },
  };
}
