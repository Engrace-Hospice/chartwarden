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
// IDEMPOTENCY_CONFLICT (a record written under another server key, i.e. after a secret rotation, is a 409
// IDEMPOTENCY_KEY_STALE); a concurrent duplicate still in flight is a 409 IDEMPOTENCY_IN_FLIGHT.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
// A concurrent duplicate uses its own code so a client keeps its key and retries instead of renewing it while the first
// request is still writing.
//
// RETRYABLE FAILURES (a 5xx, the 409s CONCURRENT_UPDATE and M10_RECORD_BUSY, and a 401 or 403 refusal) are released instead of cached, but ONLY when
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
// answers 409 in flight or STUCK until the outcome is reconciled. What the tracker cannot see (an outbound call, a queue or object-store
// write made directly in a route) is not counted: those belong behind the outbox, after the commit.
//
// A claim that is never completed or released (the process died after it, the store failed on `complete` and on `release`, or a
// route hijacks its reply so `onSend` never runs: the M33 CSV export streams) stays `pending`. A duplicate is told IN_FLIGHT for
// IDEMPOTENCY_PENDING_MAX_AGE_MS and STUCK after it (`@chartwarden/shared` idempotency.ts); the row is never reclaimed or re-run.
//
// THE RELEASE FENCES THE REQUEST (CW-AC-36). The proof above is a snapshot of the instant the response is built, and a route that
// answers a 5xx/503 while its handler keeps running (a Promise.race deadline, a timeout wrapper) can still issue its FIRST write
// afterwards, which the snapshot cannot see; released, the key would then run again beside that write. So a release is made together
// with a fence on the request's commit tracker (`fenceIfUncommitted`, one synchronous step): from then on the one pool builder
// refuses every write that request's connections issue (`WriteFencedError`, before it is sent, logged once per refusal with the key
// and no payload). A released key is not followed by a commit of the request that released it, except for the two residuals below.
// An `onSend` or `onResponse` hook that writes on a retryable response is refused as well (none does; the M34 ledger and the read audit
// write on a 2xx only), and abandoned work nobody awaits must attach its own `.catch` (the pool's own promise is marked handled, a
// chain built on it is not). Work shared across requests that was STARTED under this one (a single-flight read, a memoised loader)
// keeps this request's tracker, so once the request is fenced a write in it is refused for every waiter: none writes today. A route
// that must write AFTER it has answered a retryable failure now fails loudly instead of writing twice: it writes before it answers
// (M32 AI invocation and the M23 DDE provider send already write their ledger or in-doubt row first, which is tracked, so they are
// cached, not released).
//
// TWO RESIDUALS that remain, stated plainly. (1) The fail-closed rule holds only at its two checkpoints, the claim (below) and
// `onSend`: it does not see an async context that is lost INSIDE the handler, so a write made after that point reaches no tracker
// (nothing to count, nothing to fence), and a failure that then reaches `onSend` with the context intact is released although a write
// committed. (2) What is not a Postgres statement is neither counted nor fenced: an outbound call or a queue / object-store write
// made directly in an abandoned route can still happen after the release.
import {
  createCommitTracker,
  currentCommitTracker,
  fenceIfUncommitted,
  resetCommitTracker,
  runOutsideCommitTracker,
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

/** Per-request marker: a `pending` lock this request opened and must `complete` (or `release`) on send. */
const pendingCaptures = new WeakMap<
  FastifyRequest,
  { orgId: string; key: string; claimId: string; requestHash: string }
>();

/**
 * The error codes of the retryable 409s: the deadlock/serialization 409 (error-handler.ts), M10's lock-wait timeout
 * (`M10_RECORD_BUSY`) and M8's state-dependent closure-override refusal (`NOTE_CLOSURE_SUBJECT_NOT_BLOCKED`: the clinician is not
 * blocked RIGHT NOW, which can change in seconds, so a same-key retry must run again, not replay the refusal for 24h). Each says
 * "this step was not applied; check, then retry". (A bootstrap file imports no module, so the M8 code is spelled here.)
 */
const RETRYABLE_CONFLICT_CODES: ReadonlySet<unknown> = new Set([
  "CONCURRENT_UPDATE",
  "M10_RECORD_BUSY",
  "NOTE_CLOSURE_SUBJECT_NOT_BLOCKED",
]);

/** The per-request commit trackers: opened in `onRequest` (so the ambient store covers the whole request), read in `onSend`. */
const commitTrackers = new WeakMap<FastifyRequest, CommitTracker>();

/**
 * A response that SAYS the write did not happen and the client should run it again — any 5xx, the retryable
 * 409s (deadlock/serialization, M10 lock-wait timeout), and a 401/403 refusal. Replaying it for the 24h TTL would turn "retry" into "never" when the write really did not run;
 * these are released instead of completed, but only if the request also committed nothing (see the header).
 *
 * A 401/403 is here because the claim is made BEFORE the route's own guards run, so a refusal (a 403 STEP_UP_REQUIRED, a
 * permission not yet granted) would otherwise be replayed to a same-key retry made after the caller completed the step-up
 * or was granted the permission: the refusal is a fact about the caller at that moment, not about the request. Only
 * refusals are released. A 2xx is still replayed before the guards run (the fingerprint binds org, user and actor kind, and
 * the replayed body is what that same user was already given); re-running scope on a replay was not added here.
 */
function isRetryableOutcome(statusCode: number, body: unknown): boolean {
  if (statusCode >= 500 || statusCode === 401 || statusCode === 403) return true;
  if (statusCode !== 409 || typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    RETRYABLE_CONFLICT_CODES.has((error as { code?: unknown }).code)
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
    const requestHash = computeIdempotencyHash(scope, key, request.body ?? null, hmacKey);
    // The shared claim (`@chartwarden/shared` claimIdempotencyKey, the core of runIdempotent) decides: a cached
    // response replays, a different body is 409 IDEMPOTENCY_CONFLICT, a record under another server key (a rotated secret) is
    // 409 IDEMPOTENCY_KEY_STALE, a duplicate still in flight is 409 IDEMPOTENCY_IN_FLIGHT, and an abandoned old claim is
    // 409 IDEMPOTENCY_KEY_STUCK. Only the keyed `h1:` fingerprint matches: a record the pre-HMAC middleware wrote (plain SHA-256,
    // no prefix) is never replayed and never re-run, it answers 409 IDEMPOTENCY_CONFLICT until its 24 h TTL ends (CW-SEC-02).
    const claim = await claimIdempotencyKey(store, orgId, key, requestHash);
    if (claim.kind === "replay")
      return reply
        .code(Number(claim.response.status) || 200)
        .send(claim.response.body);
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
    pendingCaptures.set(request, { orgId, key, claimId: claim.claimId, requestHash });
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
    if (retryable && tracker !== undefined && !ownsContext) {
      request.log.warn(
        { idempotencyKey: marker.key, statusCode: reply.statusCode },
        "idempotency: the async context was lost before the response; a retryable failure is cached, not released",
      );
    }
    // THE PROOF AND THE FENCE ARE ONE STEP (CW-AC-36). "Nothing of this request committed" is true only of this instant: work the
    // handler abandoned (a deadline 503 over a handler that has not issued its first write) can still write afterwards, and
    // would commit beside the same-key retry that the release below invites. So the release is allowed only together with a
    // fence on the request's tracker, set in the same synchronous turn as the check: from then on the pool refuses every write
    // the request issues, so a released key is never followed by a commit of the request that released it.
    const log = request.log;
    const mayRelease =
      retryable &&
      tracker !== undefined &&
      ownsContext &&
      fenceIfUncommitted(tracker, () =>
        log.warn(
          { idempotencyKey: marker.key },
          "idempotency: a write was refused: this request's claim was released after a retryable failure, so it may not write any more",
        ),
      );
    if (mayRelease) {
      // Nothing of this request committed, so "retry" is true: free the key so the same-key retry runs instead of replaying
      // the failure. A failed release leaves the record `pending` (a retry answers 409 in flight or STUCK until reconciliation), the
      // same fail-safe as a failed `complete`; it is logged, never allowed to rewrite the response.
      try {
        // Outside the request's tracker: the release is a DELETE, a write, and the request is fenced from this line on.
        await runOutsideCommitTracker(() =>
          store.release(marker.orgId, marker.key, marker.claimId, marker.requestHash),
        );
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
      await store.complete(marker.orgId, marker.key, marker.claimId, response);
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
 * caller gets a generation token. Completed records expire and can be reclaimed; a pending record
 * has an unknown outcome and remains protected until it is completed or reconciled.
 * Production injects the Postgres-backed store with the same contract. Exported for boot wiring + tests.
 */
export function createInMemoryIdempotencyStore(
  options: InMemoryIdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? IN_MEMORY_TTL_MS;
  const now = options.now ?? Date.now;
  type Entry = { record: IdempotencyRecord; expiresAt: number; claimedAt: number; claimId: string };
  const entries = new Map<string, Entry>();
  const k = (orgId: string, key: string) => `${orgId} ${key}`;
  return {
    async load(orgId, key) {
      const entry = entries.get(k(orgId, key));
      if (!entry) return null;
      if (entry.record.state === "pending")
        return { ...entry.record, pendingForMs: now() - entry.claimedAt };
      return entry.expiresAt > now() ? entry.record : null;
    },
    async putPending(orgId, key, requestHash) {
      const existing = entries.get(k(orgId, key));
      if (
        existing &&
        (existing.record.state === "pending" || existing.expiresAt > now())
      )
        return null;
      const claimId = randomUUID();
      entries.set(k(orgId, key), {
        record: { state: "pending", requestHash },
        expiresAt: now() + ttlMs,
        claimedAt: now(),
        claimId,
      });
      return claimId;
    },
    async complete(orgId, key, claimId, response) {
      const existing = entries.get(k(orgId, key));
      // Only the exact claim generation may complete; TTL does not release an unknown pending outcome.
      if (existing?.record.state !== "pending" || existing.claimId !== claimId) return;
      entries.set(k(orgId, key), {
        record: { state: "complete", requestHash: existing.record.requestHash, response },
        expiresAt: now() + ttlMs,
        claimedAt: existing.claimedAt,
        claimId,
      });
    },
    async release(orgId, key, claimId, requestHash) {
      // Only the exact claimant's pending record goes; never a newer generation or completed response.
      const existing = entries.get(k(orgId, key));
      if (
        existing?.record.state !== "pending" ||
        existing.claimId !== claimId ||
        existing.record.requestHash !== requestHash
      ) {
        return;
      }
      entries.delete(k(orgId, key));
    },
  };
}
