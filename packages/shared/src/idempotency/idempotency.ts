// @chartwarden/shared — Idempotency helper (M1 Foundation §3.10; M1-T08).
//
// Core of the `Idempotency-Key` mutation guard (W-M1-10). The request fingerprint is an HMAC-SHA-256 of
// (organization_id, key, body) under a SERVER key (SEC-025 / M01-F13), so the same key with a different body is a
// CONFLICT rather than a silent replay (and a record written under another server key is STALE, not a conflict). It is KEYED because the body can be a credential: a plain hash in the
// table would let anyone who can read it test guesses for the secret offline; an HMAC cannot be tested without the
// server key. A `pending` state guards the concurrent-duplicate race (M01-F15). Storage is dependency-injected
// (IdempotencyStore): packages/shared is a leaf and never imports @chartwarden/db or reads the environment — the real
// Valkey/Postgres store and the server key are supplied by the M1 backend bootstrap (M1-T10), where the HTTP
// middleware that wraps this helper is wired too.
import { createHash, createHmac } from "node:crypto";
import {
  ConflictError,
  IdempotencyConflictError,
  IdempotencyKeyStaleError,
} from "@chartwarden/types";

/** Marks a keyed fingerprint. A stored value without it is the pre-HMAC plain SHA-256 (see {@link idempotencyHashMatches}). */
export const IDEMPOTENCY_HASH_PREFIX = "h1:";

/** Stable, canonical-enough serialization: undefined bodies normalize to null so the hash is deterministic. */
const canonicalRequest = (organizationId: string, key: string, body: unknown): string =>
  JSON.stringify({ organizationId, key, body: body ?? null });

/** The label the key id is an HMAC of, so the id is a function of the server key and nothing else. */
const KEY_ID_LABEL = "chartwarden:idempotency:key-id";
/** A stored keyed fingerprint: `h1:` + the key id + `:` + the HMAC. */
const KEYED_HASH = /^h1:([0-9a-f]{8}):[0-9a-f]{64}$/;

/**
 * A short, non-secret label of the server key: the first 8 hex characters of HMAC(key, a fixed label). Every fingerprint carries it, so a
 * mismatch can be told apart as "the server's key changed since this record was written" (stale) from "another body" (conflict). It is
 * the same for every row under one key, so it gives a reader of the table nothing to test a BODY guess against. It does let a reader test
 * CANDIDATE SERVER SECRETS offline (the label is public and the tag is 32 bits), so the fingerprint's strength against someone who can read
 * the table rests on BETTER_AUTH_SECRET being generated high-entropy, never chosen; production boot checks its presence and length only.
 */
export function idempotencyKeyId(hmacKey: string | Uint8Array): string {
  return createHmac("sha256", hmacKey).update(KEY_ID_LABEL).digest("hex").slice(0, 8);
}

/** `h1:` + key id + `:` + HMAC-SHA-256 hex of (organization_id, key, body) under the server key — the request fingerprint (SEC-025 / F13). */
export function computeIdempotencyHash(
  organizationId: string,
  key: string,
  body: unknown,
  hmacKey: string | Uint8Array,
): string {
  return `${IDEMPOTENCY_HASH_PREFIX}${idempotencyKeyId(hmacKey)}:${createHmac("sha256", hmacKey)
    .update(canonicalRequest(organizationId, key, body))
    .digest("hex")}`;
}

/**
 * Was the STORED fingerprint written under a different server key than the one computing `requestHash` (a rotated `BETTER_AUTH_SECRET`)?
 * Only two well-formed keyed values with different key ids say so; a legacy (plain SHA-256) or malformed record never does, so the
 * caller keeps reporting those as an ordinary conflict.
 */
export function idempotencyKeyIsStale(stored: string, requestHash: string): boolean {
  const storedId = KEYED_HASH.exec(stored)?.[1];
  const currentId = KEYED_HASH.exec(requestHash)?.[1];
  return storedId !== undefined && currentId !== undefined && storedId !== currentId;
}

/**
 * The fingerprint this module stored BEFORE it was keyed: plain SHA-256 hex. Only ever COMPUTED, to recognise a record written
 * before the deploy that introduced the keyed hash (records live 24 h), so a client's retry of an in-flight or completed request
 * still replays instead of being re-executed. It is never written. REMOVAL: remove this function and the legacy arm that uses it after 2026-11-16, once every environment has passed one TTL after deploy.
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

/** The one `Idempotency-Key`-reused-with-a-different-body error (409 IDEMPOTENCY_CONFLICT, SEC-025). */
export { IdempotencyConflictError };

/** Thrown when a duplicate arrives while the first request is still in flight (F15) — 409 CONFLICT. */
export class IdempotencyInFlightError extends ConflictError {
  constructor(readonly key: string) {
    super("Idempotency-Key request is still being processed");
    this.name = "IdempotencyInFlightError";
  }
}

/** The stale-key error (409 IDEMPOTENCY_KEY_STALE): a record written under another server key (the secret was rotated since). */
export { IdempotencyKeyStaleError };

/**
 * Replay a stored record: its response when complete; a conflict on a different body; in flight otherwise. A fingerprint written
 * under ANOTHER server key (a rotated secret) is not a different body: it is refused as stale, so the client does not hunt for one,
 * and nothing can say whether the first request took effect. A record stored before the keyed hash (24 h TTL) still matches the same
 * request through `legacyHash`, so a retry across the deploy replays instead of re-executing.
 */
function replay(
  record: IdempotencyRecord,
  key: string,
  requestHash: string,
  legacyHash: () => string,
): IdempotentResponse {
  if (!idempotencyHashMatches(record.requestHash, requestHash, legacyHash)) {
    throw idempotencyKeyIsStale(record.requestHash, requestHash)
      ? new IdempotencyKeyStaleError()
      : new IdempotencyConflictError();
  }
  if (record.state === "complete") return record.response;
  throw new IdempotencyInFlightError(key);
}

/**
 * Claim `(organizationId, key)` for a request fingerprinted `requestHash`. Resolves `null` when THIS caller
 * now owns the key and must run the handler (then `store.complete` it); otherwise resolves the cached
 * response to replay. Throws {@link IdempotencyConflictError} for a different body,
 * {@link IdempotencyKeyStaleError} for a record under another server key, and
 * {@link IdempotencyInFlightError} while the first request is still pending. The claim (`putPending`) is the
 * serialization point (GAP-007): a caller that loses it never runs the handler — it reloads the winner's
 * record, and a record that vanished in between is reported in flight so the client retries.
 */
export async function claimIdempotencyKey(
  store: IdempotencyStore,
  organizationId: string,
  key: string,
  requestHash: string,
  legacyHash: () => string,
): Promise<IdempotentResponse | null> {
  const existing = await store.load(organizationId, key);
  if (existing) return replay(existing, key, requestHash, legacyHash);
  if (await store.putPending(organizationId, key, requestHash)) return null;
  const winner = await store.load(organizationId, key);
  if (winner) return replay(winner, key, requestHash, legacyHash);
  throw new IdempotencyInFlightError(key);
}

/**
 * Runs `handler` at most once per (organizationId, key). On a first call it records a
 * `pending` lock, runs the handler, stores and returns the response. A later call with
 * the SAME body replays the cached response; with a DIFFERENT body it throws
 * IdempotencyConflictError; while the first is still `pending` it throws
 * IdempotencyInFlightError.
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
  const cached = await claimIdempotencyKey(store, organizationId, key, requestHash, () =>
    legacyIdempotencyHash(organizationId, key, body),
  );
  if (cached) return cached;
  const response = await handler();
  await store.complete(organizationId, key, response);
  return response;
}
