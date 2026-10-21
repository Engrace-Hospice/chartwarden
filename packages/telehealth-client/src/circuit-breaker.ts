// @chartwarden/telehealth-client — the telehealth-vendor circuit breaker (M31-T05, spec §4.5 / §7.3 / M1 §25.14).
// One breaker guards the vendor endpoint so a Daily.co outage fails fast into the §7.3 Tier-3 degraded path
// (offer audio-only, then reschedule-in-person) instead of blocking the room-mint / join flow. The breaker
// logic here is PURE and deterministic — `nowInstant` and the rolling-failure window are injected, never read
// from a clock — so the open/half-open/close transitions unit-test with no timers. Mirrors the M17
// routing-client / M10 iqies-client breaker precedent (same snapshot value-object so a re-pick is identical).

/** §4.9 platform defaults: 5 failures in 60 s → open 60 s → half-open with 1 probe. */
export const TELEHEALTH_CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,
  windowSeconds: 60,
  openDurationSeconds: 60,
  halfOpenProbeCount: 1,
  /** The per-request timeout (`AbortSignal.timeout`); a slow vendor never blocks the join flow. */
  timeoutMs: 8_000,
} as const;

export type TelehealthCircuitBreakerConfig = typeof TELEHEALTH_CIRCUIT_BREAKER_CONFIG;

/** The three breaker states (closed = healthy; open = fail-fast/degraded; half_open = single probe in flight). */
export type TelehealthBreakerState = "closed" | "open" | "half_open";

/**
 * The breaker's persisted state — a value object the adapter carries between calls (Valkey-backed in prod,
 * keyed on the vendor endpoint). `recentFailureInstants` is the rolling list of failure timestamps inside the
 * window; `openedAt` is set when the breaker trips. Everything is data so a re-pick reconstructs the verdict.
 */
export interface TelehealthBreakerSnapshot {
  readonly state: TelehealthBreakerState;
  readonly recentFailureInstants: readonly string[];
  readonly openedAt: string | null;
}

/** A fresh, healthy breaker (no failures, closed). */
export const INITIAL_TELEHEALTH_BREAKER_SNAPSHOT: TelehealthBreakerSnapshot = {
  state: "closed",
  recentFailureInstants: [],
  openedAt: null,
};

const ms = (iso: string): number => Date.parse(iso);

/**
 * `evaluateTelehealthBreaker` — the read-side decision: given the snapshot and `nowInstant`, may the adapter
 * attempt a call, and what is the effective state? An `open` breaker whose `openDurationSeconds` has elapsed
 * transitions to `half_open` (one probe allowed). A `half_open` breaker allows exactly the probe. Pure.
 */
export function evaluateTelehealthBreaker(
  snapshot: TelehealthBreakerSnapshot,
  nowInstant: string,
  config: TelehealthCircuitBreakerConfig = TELEHEALTH_CIRCUIT_BREAKER_CONFIG,
): { readonly effectiveState: TelehealthBreakerState; readonly allowed: boolean } {
  if (snapshot.state === "open") {
    const openedAt = snapshot.openedAt;
    const cooled =
      openedAt != null && ms(nowInstant) - ms(openedAt) >= config.openDurationSeconds * 1000;
    return cooled
      ? { effectiveState: "half_open", allowed: true }
      : { effectiveState: "open", allowed: false };
  }
  return { effectiveState: snapshot.state, allowed: true };
}

/**
 * `applyTelehealthOutcome` — the write-side transition: fold a `success`/`failure` into the snapshot at
 * `nowInstant`. A success from `half_open` (the probe) closes the breaker and clears the window; a failure
 * appends to the window and trips to `open` once the count inside `windowSeconds` reaches `failureThreshold`;
 * a failure from `half_open` re-opens immediately. Deterministic.
 */
export function applyTelehealthOutcome(
  snapshot: TelehealthBreakerSnapshot,
  outcome: "success" | "failure",
  nowInstant: string,
  config: TelehealthCircuitBreakerConfig = TELEHEALTH_CIRCUIT_BREAKER_CONFIG,
): TelehealthBreakerSnapshot {
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
