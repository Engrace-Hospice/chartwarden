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
): Promise<IdempotentResponse> {
  const requestHash = computeIdempotencyHash(organizationId, key, body);

  const existing = await store.load(organizationId, key);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new IdempotencyConflictError(key);
    if (existing.state === "complete") return existing.response;
    throw new IdempotencyInFlightError(key);
  }

  if (!(await store.putPending(organizationId, key, requestHash))) {
    // Lost the claim to a concurrent duplicate: never run the handler. Reload the winner's record.
    const winner = await store.load(organizationId, key);
    if (winner && winner.requestHash !== requestHash) throw new IdempotencyConflictError(key);
    if (winner?.state === "complete") return winner.response;
    throw new IdempotencyInFlightError(key);
  }
  const response = await handler();
  await store.complete(organizationId, key, response);
  return response;
}
