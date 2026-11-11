// @chartwarden/shared — Idempotency helper (M1 Foundation §3.10; M1-T08).
//
// Core of the `Idempotency-Key` mutation guard (W-M1-10). The request fingerprint is a
// SHA-256 of (organization_id, key, body) per SEC-025 / M01-F13, so the same key with a
// different body is a CONFLICT rather than a silent replay. A `pending` state guards the
// concurrent-duplicate race (M01-F15). Storage is dependency-injected (IdempotencyStore):
// packages/shared is a leaf and never imports @chartwarden/db — the real Valkey/Postgres
// store is supplied by the M1 backend bootstrap (M1-T10) and the HTTP middleware that
// wraps this helper is wired there too.
import { createHash } from "node:crypto";
import { ChartWardenError, ERROR_CODES, IdempotencyConflictError } from "@chartwarden/types";

/** SHA-256 hex of (organization_id, key, body) — the request fingerprint (SEC-025 / F13). */
export function computeIdempotencyHash(organizationId: string, key: string, body: unknown): string {
  // Stable, canonical-enough serialization: undefined bodies normalize to null so the
  // hash is deterministic across "no body" representations.
  const canonical = JSON.stringify({ organizationId, key, body: body ?? null });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The cached outcome of a completed idempotent mutation. */
export interface IdempotentResponse {
  readonly status: string;
  readonly body: unknown;
}

/** A stored idempotency record: in-flight (`pending`) or finished (`complete`). */
export type IdempotencyRecord =
  | {
      readonly state: "pending";
      readonly requestHash: string;
      /** How long the claim has been pending, by the store's own clock; absent when the store cannot say (treated as young). */
      readonly pendingForMs?: number;
    }
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
  /**
   * Drops the caller's own still-`pending` claim so the SAME key can run again. For a failure that must not be
   * replayed because NOTHING of the request committed (a deadlock/serialization 409, a 5xx that followed no durable write; the
   * HTTP middleware proves that with the per-request commit tracker before it calls this): caching it would answer every
   * retry with the failure for the whole TTL while the write never ran. A failure that followed a commit is completed, not
   * released: re-running it would write twice. Only the claimant's row goes: a row that is no longer `pending`, or whose
   * `requestHash` is another claimant's, is left alone. If this call fails the key stays `pending` until its TTL.
   */
  release(organizationId: string, key: string, requestHash: string): Promise<void>;
}

/** The one `Idempotency-Key`-reused-with-a-different-body error (409 IDEMPOTENCY_CONFLICT, SEC-025). */
export { IdempotencyConflictError };

/**
 * Thrown when a duplicate arrives while the first request is still in flight (F15) — 409 IDEMPOTENCY_IN_FLIGHT. Its own code,
 * not the plain CONFLICT: a client must be able to tell "your first request is still running, retry with the same key" from a
 * business-rule 409, because renewing the key on this answer would write twice.
 */
export class IdempotencyInFlightError extends ChartWardenError {
  constructor(readonly key: string) {
    super(
      "IDEMPOTENCY_IN_FLIGHT",
      "Idempotency-Key request is still being processed",
      ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
    );
    this.name = "IdempotencyInFlightError";
  }
}

/**
 * How long a claim may stay `pending` before a duplicate is told the key is STUCK rather than in flight: the longest a request
 * handler is meant to run plus a wide margin. Nothing in the platform runs a handler for more than a minute or two (database
 * statements, outbound calls and the proxy all time out well inside that; report and export builds run as queued jobs), so a
 * claim still pending after fifteen minutes belongs to a process that died after claiming it, or to a request whose outcome
 * could not be recorded. Far under the 24 hour record TTL, which is how long a client would otherwise loop on IN_FLIGHT.
 */
export const IDEMPOTENCY_PENDING_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Thrown when a duplicate finds the first request still `pending` after IDEMPOTENCY_PENDING_MAX_AGE_MS — 409
 * IDEMPOTENCY_KEY_STUCK. The first request's outcome is unknown (it may have been applied), so the client is told not to retry
 * with this key and to read the resource to find out. The row is never reclaimed, released or re-run by this path.
 */
export class IdempotencyKeyStuckError extends ChartWardenError {
  constructor(readonly key: string) {
    super(
      "IDEMPOTENCY_KEY_STUCK",
      "The first request with this Idempotency-Key did not finish and its outcome is unknown. Do not retry with this key: read the resource to see whether the change was applied, and use a new key only if it was not.",
      ERROR_CODES.IDEMPOTENCY_KEY_STUCK,
    );
    this.name = "IdempotencyKeyStuckError";
  }
}

/** Replay a stored record: its response when complete; a conflict on a different body; stuck or in flight otherwise. */
function replay(record: IdempotencyRecord, key: string, requestHash: string): IdempotentResponse {
  if (record.requestHash !== requestHash) throw new IdempotencyConflictError();
  if (record.state === "complete") return record.response;
  if ((record.pendingForMs ?? 0) > IDEMPOTENCY_PENDING_MAX_AGE_MS)
    throw new IdempotencyKeyStuckError(key);
  throw new IdempotencyInFlightError(key);
}

/**
 * Claim `(organizationId, key)` for a request fingerprinted `requestHash`. Resolves `null` when THIS caller
 * now owns the key and must run the handler (then `store.complete` it); otherwise resolves the cached
 * response to replay. Throws {@link IdempotencyConflictError} for a different body,
 * {@link IdempotencyInFlightError} while the first request is still pending, and {@link IdempotencyKeyStuckError} once it has been
 * pending for longer than IDEMPOTENCY_PENDING_MAX_AGE_MS. The claim (`putPending`) is the
 * serialization point (GAP-007): a caller that loses it never runs the handler — it reloads the winner's
 * record, and a record that vanished in between is reported in flight so the client retries.
 */
export async function claimIdempotencyKey(
  store: IdempotencyStore,
  organizationId: string,
  key: string,
  requestHash: string,
): Promise<IdempotentResponse | null> {
  const existing = await store.load(organizationId, key);
  if (existing) return replay(existing, key, requestHash);
  if (await store.putPending(organizationId, key, requestHash)) return null;
  const winner = await store.load(organizationId, key);
  if (winner) return replay(winner, key, requestHash);
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
): Promise<IdempotentResponse> {
  const requestHash = computeIdempotencyHash(organizationId, key, body);
  const cached = await claimIdempotencyKey(store, organizationId, key, requestHash);
  if (cached) return cached;
  const response = await handler();
  await store.complete(organizationId, key, response);
  return response;
}
