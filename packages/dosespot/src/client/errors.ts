// @chartwarden/dosespot — the typed adapter-failure contract (M12-T06, spec §2.5 / §4.10 / D5, D11). Per
// WARDENX_INTEGRATIONS §3.2 (INT-009) a raw `fetch` rejection must NEVER propagate to an M12 caller:
// every DoseSpot transport failure is normalised to the INT-009 five-field `DegradedError` so the
// `transmit-newrx` worker decides retry-vs-DLQ from `retryable` alone, the `dosespot_degraded` per-tenant
// flag flips on circuit open (D11), and the M36 `dosespot.degraded` alert (§4.9) carries only the
// integration / operation / correlation id — never PHI (the adapter never logs request/response bodies in
// the clear, Security Hardening §4.7). `packages/dosespot/src/client/` is the only place allowed to talk to
// DoseSpot (D5); this is its failure contract.

/** The eight DoseSpot operations M12 consumes (§2.5 `DoseSpotClient`). `operation` field of the errors. */
export type DoseSpotOperation =
  | "upsertPatient"
  | "enrollPrescriber"
  | "revokePrescriber"
  | "transmitNewRx"
  | "lookupRxBenefit"
  | "pullMedicationHistory"
  | "respondToRefillRequest"
  | "getPrescriptionStatus"
  | "initiateEpcsSigningSession";

/**
 * §4.10 — the INT-009 five-field degraded-error envelope. `retryable: true` covers 429 / 5xx / network
 * timeouts (BullMQ retries per §4.8); `retryable: false` covers 4xx (other than 429) validation + permanent
 * DoseSpot rejection (the job is DLQ'd immediately). `customerMessage` is PHI-free + human-readable;
 * `correlationId` is the request-correlation UUID that ties the failure to the adapter's structured log
 * without exposing the request/response bodies.
 */
export class DegradedError extends Error {
  constructor(
    public readonly integration: "dosespot", // field 1 — integration name
    public readonly operation: DoseSpotOperation, // field 2 — which operation failed
    public readonly retryable: boolean, // field 3 — transient vs permanent
    public readonly customerMessage: string, // field 4 — human-readable, no PHI
    public readonly correlationId: string, // field 5 — request correlation UUID
  ) {
    super(`[dosespot/${operation}] ${customerMessage} (correlationId=${correlationId})`);
    this.name = "DegradedError";
  }
}

/** Narrow an unknown thrown value to a {@link DegradedError} (the worker's retry/DLQ branch keys on it). */
export function isDegradedError(value: unknown): value is DegradedError {
  return value instanceof DegradedError;
}

/**
 * §4.10 — the in-call retryable marker. Raised inside the adapter's `call()` for a 429 (rate-limited) or a
 * 5xx so the per-call exponential backoff (§4.10 `retry.ts`, 250/500/1000ms) re-attempts before the circuit
 * breaker counts a failure. It is never thrown to the M12 caller — once the per-call attempts exhaust, the
 * adapter converts it to a `retryable: true` {@link DegradedError} so the BullMQ job re-queues with backoff.
 */
export class RetryableError extends Error {
  constructor(
    public readonly reason: "rate_limited" | "upstream_5xx" | "network_timeout",
    public readonly errorClass: string,
  ) {
    super(`[dosespot] retryable: ${reason} (${errorClass})`);
    this.name = "RetryableError";
  }
}

/** Narrow an unknown thrown value to a {@link RetryableError} (the per-call backoff loop keys on it). */
export function isRetryableError(value: unknown): value is RetryableError {
  return value instanceof RetryableError;
}
