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
import { ConflictError, IdempotencyConflictError } from "@chartwarden/types";

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

/** Replay a stored record: its response when complete; a conflict on a different body; in flight otherwise. */
function replay(record: IdempotencyRecord, key: string, requestHash: string): IdempotentResponse {
  if (record.requestHash !== requestHash) throw new IdempotencyConflictError();
  if (record.state === "complete") return record.response;
  throw new IdempotencyInFlightError(key);
}

/**
 * Claim `(organizationId, key)` for a request fingerprinted `requestHash`. Resolves `null` when THIS caller
 * now owns the key and must run the handler (then `store.complete` it); otherwise resolves the cached
 * response to replay. Throws {@link IdempotencyConflictError} for a different body and
 * {@link IdempotencyInFlightError} while the first request is still pending. The claim (`putPending`) is the
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
