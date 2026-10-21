// @chartwarden/dosespot — the per-tenant circuit breaker (M12-T06, spec §2.5 / Integrations §3.2 / M1 §25.14).
// One breaker is instantiated per `organization_id` (one DoseSpot clinic per tenant) so a single-tenant
// outage never opens the circuit for other tenants (§2.5 blast-radius). The breaker logic here is PURE and
// deterministic — `nowInstant` and the rolling-failure window are injected, never read from a clock — so the
// `transmit-newrx` worker can unit-test the open/half-open/close transitions with no timers. On `open` the
// adapter throws {@link DegradedError} immediately (the caller re-queues with BullMQ backoff), flips the
// per-tenant `dosespot_degraded` flag to `true` (D11), and emits the M36 `dosespot.degraded` alert (§4.9);
// on close it clears the flag and emits `dosespot.recovered`. Mirrors the M10 iqies-client breaker precedent.
import { DegradedError, type DoseSpotOperation } from "./errors";

/** §2.5 platform defaults: 5 failures in 60 s → open 30 s → half-open with 1 probe (M1 §25.14). */
export const DOSESPOT_CIRCUIT_BREAKER_CONFIG = {
  // §2.5: "Breaker opens at 5 consecutive failures within 60s; half-open probes at 30s intervals."
  failureThreshold: 5,
  windowSeconds: 60,
  openDurationSeconds: 30,
  halfOpenProbeCount: 1,
} as const;

export type DoseSpotCircuitBreakerConfig = typeof DOSESPOT_CIRCUIT_BREAKER_CONFIG;

/** The three breaker states (closed = healthy; open = fail-fast; half_open = single probe in flight). */
export type BreakerState = "closed" | "open" | "half_open";

/**
 * The breaker's persisted state — a value object the worker carries between ticks (e.g. in Valkey keyed on
 * `dosespot:<organizationId>`). `recentFailureInstants` is the rolling list of failure timestamps inside the
 * window; `openedAt` is set when the breaker trips. Everything is data so a re-pick after a runner crash
 * reconstructs the same verdict.
 */
export interface BreakerSnapshot {
  readonly state: BreakerState;
  /** ISO instants of failures still inside `windowSeconds` as of the last `applyOutcome`. */
  readonly recentFailureInstants: readonly string[];
  /** ISO instant the breaker last opened; null while closed/half-open without a trip. */
  readonly openedAt: string | null;
}

/** A fresh, healthy breaker (no failures, closed). */
export const INITIAL_BREAKER_SNAPSHOT: BreakerSnapshot = {
  state: "closed",
  recentFailureInstants: [],
  openedAt: null,
};

const ms = (iso: string): number => Date.parse(iso);

/**
 * `evaluateBreaker` — the read-side decision: given the current snapshot and `nowInstant`, may the worker
 * attempt a call, and what is the effective state? An `open` breaker whose `openDurationSeconds` has elapsed
 * transitions to `half_open` (one probe allowed). A `half_open` breaker allows exactly the probe. Pure: it
 * never mutates the snapshot — it reports the gate.
 */
export function evaluateBreaker(
  snapshot: BreakerSnapshot,
  nowInstant: string,
  config: DoseSpotCircuitBreakerConfig = DOSESPOT_CIRCUIT_BREAKER_CONFIG,
): { readonly effectiveState: BreakerState; readonly allowed: boolean } {
  if (snapshot.state === "open") {
    const openedAt = snapshot.openedAt;
    const cooled =
      openedAt != null && ms(nowInstant) - ms(openedAt) >= config.openDurationSeconds * 1000;
    return cooled
      ? { effectiveState: "half_open", allowed: true }
      : { effectiveState: "open", allowed: false };
  }
  // closed or half_open — both permit an attempt (half_open permits the single probe).
  return { effectiveState: snapshot.state, allowed: true };
}

/**
 * `applyOutcome` — the write-side transition: fold a `success`/`failure` into the snapshot at `nowInstant`. A
 * success from `half_open` (the probe) closes the breaker and clears the window; a success while closed prunes
 * the window to the live entries. A failure appends to the window and trips to `open` once the count inside
 * `windowSeconds` reaches `failureThreshold`; a failure from `half_open` re-opens immediately. Deterministic —
 * the same (snapshot, outcome, nowInstant) always yields the same next snapshot.
 */
export function applyOutcome(
  snapshot: BreakerSnapshot,
  outcome: "success" | "failure",
  nowInstant: string,
  config: DoseSpotCircuitBreakerConfig = DOSESPOT_CIRCUIT_BREAKER_CONFIG,
): BreakerSnapshot {
  const cutoff = ms(nowInstant) - config.windowSeconds * 1000;
  const live = snapshot.recentFailureInstants.filter((f) => ms(f) > cutoff);

  if (outcome === "success") {
    // The probe (or any closed-state success) clears the failure window and closes the breaker.
    return { state: "closed", recentFailureInstants: [], openedAt: null };
  }

  const failures = [...live, nowInstant];
  // A failure during the half-open probe re-opens immediately; otherwise trip once the threshold is met.
  const shouldOpen = snapshot.state === "half_open" || failures.length >= config.failureThreshold;
  return shouldOpen
    ? { state: "open", recentFailureInstants: failures, openedAt: nowInstant }
    : { state: "closed", recentFailureInstants: failures, openedAt: null };
}

/**
 * `didTransition` — name the breaker's edge between two snapshots so the worker knows whether to flip the
 * `dosespot_degraded` flag and which M36 alert to emit (§2.5 / D11 / §4.9). `"opened"` → flip flag true +
 * `dosespot.degraded`; `"closed"` → flip flag false + `dosespot.recovered`; `null` → no edge.
 */
export function didTransition(
  before: BreakerSnapshot,
  after: BreakerSnapshot,
): "opened" | "closed" | null {
  if (before.state !== "open" && after.state === "open") return "opened";
  if (before.state === "open" && after.state === "closed") return "closed";
  return null;
}

/**
 * Throw the §2.5 open-circuit {@link DegradedError} (retryable — BullMQ re-queues with backoff). The caller
 * uses this when {@link evaluateBreaker} denies the attempt so the failure shape is identical to a live
 * transport timeout. PHI-free by construction: only the operation + correlation id travel.
 */
export function openCircuitError(
  operation: DoseSpotOperation,
  correlationId: string,
): DegradedError {
  return new DegradedError(
    "dosespot",
    operation,
    true,
    "E-prescribe service is temporarily unavailable (circuit open); the request will retry automatically.",
    correlationId,
  );
}
