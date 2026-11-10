// @chartwarden/ui core — the Idempotency-Key primitives, in ONE React-free, import-free file: the key generator and the one rule for when
// an attempt's key survives its answer. The API client's middleware (api/idempotency-middleware.ts) and the kit's `sendWrite` both read
// them from here, so the client stays a leaf and the rule is defined once. Nothing here may import React or another module.

/** A new key: `crypto.randomUUID()`, or a time-plus-random string where it is unavailable (an insecure context such as plain http on a LAN). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface ErrorEnvelope {
  readonly code?: unknown;
  readonly message?: unknown;
}

/** The `error` object of the API error envelope (`{ error: { code, message } }`), or null for any other body. */
function envelopeOf(body: unknown): ErrorEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === "object" && error !== null ? error : null;
}

/**
 * A gateway error page: a 5xx whose body is not the API error envelope never reached the app, so the app saw no attempt and nothing is
 * known about the write. `body` is the parsed JSON, the raw text, or undefined when empty.
 */
export function isGatewayPage(status: number, body: unknown): boolean {
  if (status < 500) return false;
  return typeof envelopeOf(body)?.code !== "string";
}

/** The code the server answers a duplicate with while the first request under the same key is still being processed (409). */
export const IDEMPOTENCY_IN_FLIGHT_CODE = "IDEMPOTENCY_IN_FLIGHT";

/**
 * DEPLOY-WINDOW STOPGAP: delete this constant and `isLegacyInFlight` once every server answers `IDEMPOTENCY_IN_FLIGHT`. An older server
 * answers that duplicate with a plain 409 `CONFLICT` whose message is exactly this (IdempotencyInFlightError, packages/shared).
 * Exported only so scripts/__tests__/idempotency-in-flight-contract.test.ts can check it against the server source.
 */
export const LEGACY_IN_FLIGHT_MESSAGE = "Idempotency-Key request is still being processed";

function isLegacyInFlight(envelope: ErrorEnvelope): boolean {
  return envelope.code === "CONFLICT" && envelope.message === LEGACY_IN_FLIGHT_MESSAGE;
}

/**
 * The server says another request under this key is still running. That 409 is not the write's outcome: the first request may still be
 * running or committing, so a retry on a NEW key would run the write a second time. Keep the key.
 */
export function isInFlightDuplicate(status: number, body: unknown): boolean {
  if (status !== 409) return false;
  const envelope = envelopeOf(body);
  if (envelope === null) return false;
  return envelope.code === IDEMPOTENCY_IN_FLIGHT_CODE || isLegacyInFlight(envelope);
}

const MS_PER_MINUTE = 60_000;

/**
 * How long an intent keeps its key after its last UNANSWERED attempt (no answer, or a gateway page). The server caches an answer for a
 * limited time (24h), and a retry long after the first attempt is a new intent (the same text submitted again on purpose), which must
 * not be handed a replay of the old answer; a lost-reply retry comes in seconds to minutes. An in-flight 409 does not move it: the
 * server can leave a claim pending for its whole TTL when it fails to complete or release it, and sliding on that 409 would lock the
 * user out of that write for as long as they kept trying. Shared by the API client's middleware and the kit's keeper.
 */
export const IDEMPOTENCY_KEY_TTL_MS = 15 * MS_PER_MINUTE;

/**
 * The most an intent may keep one key, measured from its FIRST attempt however often it was retried. Sliding the idle window alone
 * would let a user who retries every 14 minutes outlive the server's fixed 24h claim; an hour is far past any lost-reply retry.
 */
export const IDEMPOTENCY_KEY_MAX_AGE_MS = 60 * MS_PER_MINUTE;

/** True once an intent is past the hard cap from its first attempt. */
export function keyPastMaxAge(firstAttemptAt: number, now: number): boolean {
  return now - firstAttemptAt >= IDEMPOTENCY_KEY_MAX_AGE_MS;
}

/** True once an intent has gone a full TTL without an unanswered attempt. */
export function keyIdleTooLong(lastAttemptAt: number, now: number): boolean {
  return now - lastAttemptAt >= IDEMPOTENCY_KEY_TTL_MS;
}

/**
 * Whether the key must survive this answer, i.e. the next attempt of the same intent reuses it: a gateway page (the app never saw the
 * attempt) or an in-flight duplicate (the first attempt is still unresolved). Every other answer, success or refusal, is the app's own
 * outcome of that attempt, so the next attempt is a new intent on a new key: the server caches a completed answer (refusals included)
 * under the key and would replay it to a retry that could never succeed. An app 5xx is such an answer too: the server released its claim
 * (so the same key would also run again), but the attempt is over and renewing is equally safe.
 */
export function keepsKey(status: number, body: unknown): boolean {
  return isGatewayPage(status, body) || isInFlightDuplicate(status, body);
}

/**
 * Headers that give ONE request its own new key, which the API client's key-per-intent middleware then leaves alone. For an action whose
 * every click means "do it now, against the CURRENT state" (validate a claim, refresh a view, probe a credential): the same click after
 * a lost reply is indistinguishable from a retry, and a retry on the old key would be handed the OLD answer, computed before whatever the
 * user changed in between. Running such an action twice is harmless, so it gives up the lost-reply replay for a fresh run every time.
 */
export function freshIdempotencyKeyHeaders(): Record<string, string> {
  return { "Idempotency-Key": newIdempotencyKey() };
}
