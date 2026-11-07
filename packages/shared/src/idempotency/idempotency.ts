// @chartwarden/shared — Idempotency helper (M1 Foundation §3.10; M1-T08).
//
// Core of the `Idempotency-Key` mutation guard (W-M1-10). The request fingerprint is an HMAC-SHA-256 of
// (organization_id, key, body) under a SERVER key (SEC-025 / M01-F13), so the same key with a different body is a
// CONFLICT rather than a silent replay. It is KEYED because the body can be a credential: a plain hash in the
// table would let anyone who can read it test guesses for the secret offline; an HMAC cannot be tested without the
// server key. A `pending` state guards the concurrent-duplicate race (M01-F15). Storage is dependency-injected
// (IdempotencyStore): packages/shared is a leaf and never imports @chartwarden/db or reads the environment — the real
// Valkey/Postgres store and the server key are supplied by the M1 backend bootstrap (M1-T10), where the HTTP
// middleware that wraps this helper is wired too.
import { createHash, createHmac } from "node:crypto";

/** Marks a keyed fingerprint. A stored value without it is the pre-HMAC plain SHA-256 (see {@link idempotencyHashMatches}). */
export const IDEMPOTENCY_HASH_PREFIX = "h1:";

/** Stable, canonical-enough serialization: undefined bodies normalize to null so the hash is deterministic. */
const canonicalRequest = (organizationId: string, key: string, body: unknown): string =>
  JSON.stringify({ organizationId, key, body: body ?? null });

/** `h1:` + HMAC-SHA-256 hex of (organization_id, key, body) under the server key — the request fingerprint (SEC-025 / F13). */
export function computeIdempotencyHash(
  organizationId: string,
  key: string,
  body: unknown,
  hmacKey: string | Uint8Array,
): string {
  return `${IDEMPOTENCY_HASH_PREFIX}${createHmac("sha256", hmacKey)
    .update(canonicalRequest(organizationId, key, body))
    .digest("hex")}`;
}

/**
 * The fingerprint this module stored BEFORE it was keyed: plain SHA-256 hex. Only ever COMPUTED, to recognise a record written
 * before the deploy that introduced the keyed hash (records live 24 h), so a client's retry of an in-flight or completed request
 * still replays instead of being re-executed. It is never written. ponytail: delete once one TTL has passed everywhere.
 */
export function legacyIdempotencyHash(organizationId: string, key: string, body: unknown): string {
  return createHash("sha256")
    .update(canonicalRequest(organizationId, key, body))
    .digest("hex");
}

/**
 * Does a STORED fingerprint belong to this request? A keyed (`h1:`) record matches only the same keyed value, so a record written
 * under another server key (a rotated secret) is a clean mismatch (409), never a replay. A record without the prefix is the legacy
 * form and matches when the legacy hash of the same request does; `legacy` is lazy so the plain hash is not computed otherwise.
 */
export function idempotencyHashMatches(
  stored: string,
  requestHash: string,
  legacy: () => string,
): boolean {
  if (stored === requestHash) return true;
  return !stored.startsWith(IDEMPOTENCY_HASH_PREFIX) && stored === legacy();
}

/** The cached outcome of a completed idempotent mutation. */
export interface IdempotentResponse {
  readonly status: string;
  readonly body: unknown;
}

/** A stored idempotency record: in-flight (`pending`) or finished (`complete`). */
export type IdempotencyRecord =
  | { readonly state: "pending"; readonly requestHash: string }
  | {
      readonly state: "complete";
      readonly requestHash: string;
      readonly response: IdempotentResponse;
    };

/**
 * Storage port (Valkey / Postgres `idempotency_key`) injected at boot. `putPending` is the
 * atomic CLAIM: it resolves `true` when THIS caller now owns the key (no record existed, or the
 * existing one had expired and was reclaimed) and `false` when another caller holds a live
 * record. A caller that loses the claim must not run the handler; it reloads and replays or
 * reports in-flight (GAP-007).
 */
export interface IdempotencyStore {
  load(organizationId: string, key: string): Promise<IdempotencyRecord | null>;
  putPending(organizationId: string, key: string, requestHash: string): Promise<boolean>;
  complete(organizationId: string, key: string, response: IdempotentResponse): Promise<void>;
}

/** Thrown when an idempotency key is reused with a DIFFERENT request body (SEC-025). */
export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`idempotency_conflict: key '${key}' was already used with a different request body`);
    this.name = "IdempotencyConflictError";
  }
}

/** Thrown when a duplicate arrives while the first request is still in flight (F15). */
export class IdempotencyInFlightError extends Error {
  constructor(readonly key: string) {
    super(`idempotency_in_flight: key '${key}' is still being processed by an earlier request`);
    this.name = "IdempotencyInFlightError";
  }
}

/**
 * Runs `handler` at most once per (organizationId, key). On a first call it records a
 * `pending` lock, runs the handler, stores and returns the response. A later call with
 * the SAME body replays the cached response; with a DIFFERENT body it throws
 * IdempotencyConflictError; while the first is still `pending` it throws
 * IdempotencyInFlightError (the caller maps that to HTTP 409).
 */
export async function runIdempotent(
  store: IdempotencyStore,
  organizationId: string,
  key: string,
  body: unknown,
  handler: () => Promise<IdempotentResponse>,
  hmacKey: string | Uint8Array,
): Promise<IdempotentResponse> {
  const requestHash = computeIdempotencyHash(organizationId, key, body, hmacKey);
  const matches = (stored: string) =>
    idempotencyHashMatches(stored, requestHash, () =>
      legacyIdempotencyHash(organizationId, key, body),
    );

  const existing = await store.load(organizationId, key);
  if (existing) {
    if (!matches(existing.requestHash)) throw new IdempotencyConflictError(key);
    if (existing.state === "complete") return existing.response;
    throw new IdempotencyInFlightError(key);
  }

  if (!(await store.putPending(organizationId, key, requestHash))) {
    // Lost the claim to a concurrent duplicate: never run the handler. Reload the winner's record.
    const winner = await store.load(organizationId, key);
    if (winner && !matches(winner.requestHash)) throw new IdempotencyConflictError(key);
    if (winner?.state === "complete") return winner.response;
    throw new IdempotencyInFlightError(key);
  }
  const response = await handler();
  await store.complete(organizationId, key, response);
  return response;
}
