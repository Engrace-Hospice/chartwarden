// @wardenx/routing-client — the typed adapter-failure contract (M17-T07, spec §4.10 / §7.9 / D1).
//
// Per WARDENX_INTEGRATIONS and the §25.14 adapter mandate a raw `fetch` rejection must NEVER propagate to
// an M17 caller: every routing-engine transport failure is normalised to the {@link RoutingDegradedError}
// envelope so the `optimize-day` worker (M17-T08) decides degrade-vs-skip from a single typed shape. On a
// degraded run the cron logs `m17.route_optimization_degraded`, emits the warn alert, and the day view shows
// "Optimization unavailable — visits in scheduled order" (§7.9) — no patient-care path is ever blocked.
//
// PHI boundary (D9 / §7.10): the error carries ONLY the operation + correlation id — never coordinates,
// never any patient/clinician identifier. The adapter never logs request/response bodies in the clear.

/** The two routing-engine operations M17 consumes (§4.10 `RoutingProvider`). `operation` field of the error. */
export type RoutingOperation = "matrix" | "directions";

/**
 * §4.10 / §7.9 — the degraded-routing envelope. `retryable: true` covers 429 / 5xx / network timeouts /
 * an open circuit (the worker re-queues / falls back to scheduled order); `retryable: false` covers a
 * permanent engine rejection. `customerMessage` is PHI-free + human-readable; `correlationId` ties the
 * failure to the adapter's structured log without exposing the request (which is coords-only anyway).
 */
export class RoutingDegradedError extends Error {
  constructor(
    public readonly integration: "osrm" | "mapbox", // field 1 — routing engine
    public readonly operation: RoutingOperation, // field 2 — which operation failed
    public readonly retryable: boolean, // field 3 — transient vs permanent
    public readonly customerMessage: string, // field 4 — human-readable, no PHI
    public readonly correlationId: string, // field 5 — request correlation UUID
  ) {
    super(`[${integration}/${operation}] ${customerMessage} (correlationId=${correlationId})`);
    this.name = "RoutingDegradedError";
  }
}

/** Narrow an unknown thrown value to a {@link RoutingDegradedError} (the worker's degrade branch keys on it). */
export function isRoutingDegradedError(value: unknown): value is RoutingDegradedError {
  return value instanceof RoutingDegradedError;
}
