// @wardenx/routing-client — the routing-engine circuit breaker (M17-T07, spec §4.10 / §7.9 / M1 §25.14).
// One breaker guards the shared OSRM endpoint so a routing-engine outage fails fast into the §7.9 degraded
// path (visits in scheduled order) instead of blocking the optimize-day worker. The breaker logic here is
// PURE and deterministic — `nowInstant` and the rolling-failure window are injected, never read from a clock
// — so the open/half-open/close transitions unit-test with no timers. Mirrors the M10 iqies-client / M12
// dosespot breaker precedent (same snapshot value-object so a re-pick after a runner crash is identical).

/** §4.10 platform defaults: 5 failures in 60 s → open 60 s → half-open with 1 probe (matches §4.10 `resetMs`). */
export const ROUTING_CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,
  windowSeconds: 60,
  openDurationSeconds: 60,
  halfOpenProbeCount: 1,
  /** §4.10 — the per-request timeout (`AbortSignal.timeout(3000)`); a slow OSRM never blocks the worker. */
  timeoutMs: 3_000,
} as const;

export type RoutingCircuitBreakerConfig = typeof ROUTING_CIRCUIT_BREAKER_CONFIG;

/** The three breaker states (closed = healthy; open = fail-fast/degraded; half_open = single probe in flight). */
export type BreakerState = "closed" | "open" | "half_open";

/**
 * The breaker's persisted state — a value object the worker carries between ticks (e.g. in Valkey keyed on
 * the OSRM endpoint). `recentFailureInstants` is the rolling list of failure timestamps inside the window;
 * `openedAt` is set when the breaker trips. Everything is data so a re-pick reconstructs the same verdict.
 */
export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly recentFailureInstants: readonly string[];
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
 * `evaluateBreaker` — the read-side decision: given the snapshot and `nowInstant`, may the worker attempt a
 * call, and what is the effective state? An `open` breaker whose `openDurationSeconds` has elapsed transitions
 * to `half_open` (one probe allowed). A `half_open` breaker allows exactly the probe. Pure: never mutates.
 */
export function evaluateBreaker(
  snapshot: BreakerSnapshot,
  nowInstant: string,
  config: RoutingCircuitBreakerConfig = ROUTING_CIRCUIT_BREAKER_CONFIG,
): { readonly effectiveState: BreakerState; readonly allowed: boolean } {
  if (snapshot.state === "open") {
    const openedAt = snapshot.openedAt;
    const cooled = openedAt != null && ms(nowInstant) - ms(openedAt) >= config.openDurationSeconds * 1000;
    return cooled ? { effectiveState: "half_open", allowed: true } : { effectiveState: "open", allowed: false };
  }
  return { effectiveState: snapshot.state, allowed: true };
}

/**
 * `applyOutcome` — the write-side transition: fold a `success`/`failure` into the snapshot at `nowInstant`. A
 * success from `half_open` (the probe) closes the breaker and clears the window; a failure appends to the
 * window and trips to `open` once the count inside `windowSeconds` reaches `failureThreshold`; a failure from
 * `half_open` re-opens immediately. Deterministic.
 */
export function applyOutcome(
  snapshot: BreakerSnapshot,
  outcome: "success" | "failure",
  nowInstant: string,
  config: RoutingCircuitBreakerConfig = ROUTING_CIRCUIT_BREAKER_CONFIG,
): BreakerSnapshot {
  const cutoff = ms(nowInstant) - config.windowSeconds * 1000;
  const live = snapshot.recentFailureInstants.filter((f) => ms(f) > cutoff);

  if (outcome === "success") {
    return { state: "closed", recentFailureInstants: [], openedAt: null };
  }

  const failures = [...live, nowInstant];
  const shouldOpen = snapshot.state === "half_open" || failures.length >= config.failureThreshold;
  return shouldOpen
    ? { state: "open", recentFailureInstants: failures, openedAt: nowInstant }
    : { state: "closed", recentFailureInstants: failures, openedAt: null };
}
