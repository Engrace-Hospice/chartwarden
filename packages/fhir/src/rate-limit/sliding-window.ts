// @wardenx/fhir — the tier-based rate-limit ceiling decision (§1.1 / D16 / W-FHIR-08, M28-T03).
//
// D16: a Valkey-backed sliding window enforces per-client request ceilings — tier-1 100 RPS, tier-2 10
// RPS, tier-3 1 RPS — and refuses the overflow with `429 Too Many Requests` + `Retry-After` +
// `OperationOutcome.issue.code='throttled'` (§8.3). The COUNTING lives in Valkey (the route does the
// `INCR`/`EXPIRE` against a per-second-sharded key, §2.5); THIS module is the PURE decision it consults:
// given the ceiling and the count already served in the current 1-second window, admit or throttle, and
// if throttling, how long until the window refills. IO-free, `nowMs` INJECTED (never a clock).
//
// The effective ceiling is `fhir_client.rate_limit_rps` — which the platform seeds to the tier floor and a
// tenant may only TIGHTEN (never raise above the floor), enforced at registration by
// `fhirRateLimitWithinFloor` (`domain/validation.ts`). So this module takes the already-resolved ceiling;
// it does not re-derive it from the tier, keeping the tighten-only rule in one place.
import { FHIR_TIER_RATE_LIMIT_FLOOR_RPS, type FhirClientTier } from "@wardenx/types";

/** The sliding window is one second wide (D16 ceilings are per-second). */
export const FHIR_RATE_LIMIT_WINDOW_MS = 1000;

/** The `Retry-After` (seconds) a throttled request carries (W-FHIR-08 step 2). The budget refills at the
 *  next window boundary, at most one second away, so a single second is the correct advertised wait. */
export const FHIR_RATE_LIMIT_RETRY_AFTER_SECONDS = 1;

/** The platform-floor RPS for a tier (the ceiling a fresh registration seeds). A convenience over the leaf
 *  map so a caller resolving a client with no tightened override reads one function. */
export function fhirTierCeilingRps(tier: FhirClientTier): number {
  return FHIR_TIER_RATE_LIMIT_FLOOR_RPS[tier];
}

/** The inputs the route hands the decision after its Valkey read. */
export interface FhirRateLimitInput {
  /** The client's effective ceiling in requests/second (`fhir_client.rate_limit_rps`, already
   *  tighten-resolved). Must be a positive integer; a non-positive ceiling admits nothing. */
  readonly ceilingRps: number;
  /** How many requests THIS client has already been counted for in the current 1-second window — i.e. the
   *  value Valkey `INCR` returned for this request, minus one (the count BEFORE this request). */
  readonly priorCountInWindow: number;
  /** The decision clock (ms epoch), INJECTED. Used only to compute the window-boundary `retryAfter`. */
  readonly nowMs: number;
}

/** The verdict: admit, or throttle with the FHIR-spec `Retry-After`/`resetAtMs` the `429` envelope carries. */
export type FhirRateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number; readonly resetAtMs: number };

/**
 * §D16 / W-FHIR-08 — admit or throttle. The request is the `(priorCountInWindow + 1)`-th in the window; it
 * is admitted while that ordinal is at or under the ceiling and throttled once it exceeds it (so a ceiling
 * of 10 admits requests 1..10 and throttles 11+). Fails CLOSED: a non-positive or non-integer ceiling
 * admits nothing. On throttle, `resetAtMs` is the next 1-second boundary and `retryAfterSeconds` the
 * ceil-seconds until then (≥ 1), matching the `Retry-After: 1` the spec walks through.
 */
export function fhirRateLimitDecision(input: FhirRateLimitInput): FhirRateLimitDecision {
  const { ceilingRps, priorCountInWindow, nowMs } = input;
  const admittedOrdinal = priorCountInWindow + 1;
  if (Number.isInteger(ceilingRps) && ceilingRps > 0 && admittedOrdinal <= ceilingRps) {
    return { allowed: true };
  }
  const resetAtMs = (Math.floor(nowMs / FHIR_RATE_LIMIT_WINDOW_MS) + 1) * FHIR_RATE_LIMIT_WINDOW_MS;
  const retryAfterSeconds = Math.max(
    FHIR_RATE_LIMIT_RETRY_AFTER_SECONDS,
    Math.ceil((resetAtMs - nowMs) / 1000),
  );
  return { allowed: false, retryAfterSeconds, resetAtMs };
}
