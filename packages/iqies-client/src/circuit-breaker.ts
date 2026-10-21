// @chartwarden/iqies-client — the per-ProviderEntity circuit breaker (M10-T07, spec §4.10.1 / M10-F17 /
// SD-075). One breaker is instantiated per PE endpoint (one per CCN / per MAC) so a single-PE outage
// never opens the circuit for other PEs (§4.10 per-PE blast radius). The breaker logic here is PURE and
// deterministic — `nowInstant` and the rolling-failure window are injected, never read from a clock — so
// the worker can unit-test the open/half-open/close transitions without timers. On `open`, the adapter
// throws {@link DegradedError} immediately and the caller re-queues with BullMQ backoff rather than
// blocking the Tier-2 capture path (capture never depends on submission health, §5.6 DR-010).
import { DegradedError, type IqiesOperation } from "./errors";

/** SD-075 platform defaults with the iQIES-specific slow-batch timeout override (§4.10.1). */
export const IQIES_CIRCUIT_BREAKER_CONFIG = {
  // SD-075 platform default: 5 failures in 30 s → open 60 s → half-open with 1 probe.
  failureThreshold: 5,
  windowSeconds: 30,
  openDurationSeconds: 60,
  halfOpenProbeCount: 1,
  // iQIES-specific override: iQIES batch submissions are slow (up to 20 s each); a longer per-request
  // timeout avoids spurious opens under load.
  timeoutMs: 25_000,
} as const;

export type IqiesCircuitBreakerConfig = typeof IQIES_CIRCUIT_BREAKER_CONFIG;

/** The three breaker states (closed = healthy; open = fail-fast; half_open = single probe in flight). */
export type BreakerState = "closed" | "open" | "half_open";

/**
 * The breaker's persisted state — a value object the worker carries between ticks (e.g. in Valkey keyed
 * on the PE endpoint). `recentFailureInstants` is the rolling list of failure timestamps inside the
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
 * attempt a call, and what is the effective state? An `open` breaker whose `openDurationSeconds` has
 * elapsed transitions to `half_open` (one probe allowed). A `half_open` breaker allows exactly the probe.
 * Pure: it never mutates the snapshot — it reports the gate.
 */
export function evaluateBreaker(
  snapshot: BreakerSnapshot,
  nowInstant: string,
  config: IqiesCircuitBreakerConfig = IQIES_CIRCUIT_BREAKER_CONFIG,
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
 * `applyOutcome` — the write-side transition: fold a `success`/`failure` into the snapshot at `nowInstant`.
 * A success from `half_open` (the probe) closes the breaker and clears the window; a success while closed
 * prunes the window to the live entries. A failure appends to the window and trips to `open` once the
 * count inside `windowSeconds` reaches `failureThreshold`; a failure from `half_open` re-opens immediately.
 * Deterministic — the same (snapshot, outcome, nowInstant) always yields the same next snapshot.
 */
export function applyOutcome(
  snapshot: BreakerSnapshot,
  outcome: "success" | "failure",
  nowInstant: string,
  config: IqiesCircuitBreakerConfig = IQIES_CIRCUIT_BREAKER_CONFIG,
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
 * Throw the §4.10.1 open-circuit {@link DegradedError} (retryable — BullMQ re-queues with backoff). The
 * caller uses this when {@link evaluateBreaker} denies the attempt so the failure shape is identical to a
 * live transport timeout. PHI-free by construction: only the operation + correlation id travel.
 */
export function openCircuitError(operation: IqiesOperation, correlationId: string): DegradedError {
  return new DegradedError(
    "iqies",
    operation,
    true,
    "iQIES endpoint is temporarily unavailable (circuit open); the submission will retry automatically.",
    correlationId,
  );
}
