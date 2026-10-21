// @chartwarden/iqies-client — the typed `DegradedError` every external adapter must expose (M10-T07,
// spec §4.10.1 / M10-F17 / INT-009). Per CHARTWARDEN_INTEGRATIONS §3.2 (INT-009), a raw `fetch` rejection
// must NEVER propagate to an M10 caller: every iQIES transport failure is normalised to this five-field
// shape so the `iqies-submit-worker` can decide retry-vs-DLQ from `retryable` alone and so out-of-band
// alerts (M36 `system.integration_failure`, §4.10.1) carry only the integration / operation / correlation
// id — never PHI. The adapter is the only package that talks to iQIES (D6); this is its failure contract.

/** The three iQIES operations M10 consumes (D6). `operation` field of {@link DegradedError}. */
export type IqiesOperation = "submitBatch" | "fetchAcceptanceReport" | "submitCorrection";

/**
 * §4.10.1 — the INT-009 five-field degraded-error envelope. `retryable: true` covers 429 / 5xx / network
 * timeouts (BullMQ retries per §4.8.1); `retryable: false` covers 400 validation + permanent CMS rejection
 * (the job is DLQ'd immediately and a `hope_validation_finding` is written). `customerMessage` is
 * PHI-free and human-readable; `correlationId` is the request-correlation UUID that ties the failure to
 * the adapter's structured log without exposing the envelope contents.
 */
export class DegradedError extends Error {
  constructor(
    public readonly integration: "iqies", // field 1 — integration name
    public readonly operation: IqiesOperation, // field 2 — which operation failed
    public readonly retryable: boolean, // field 3 — transient vs permanent
    public readonly customerMessage: string, // field 4 — human-readable, no PHI
    public readonly correlationId: string, // field 5 — request correlation UUID
  ) {
    super(`[iqies/${operation}] ${customerMessage} (correlationId=${correlationId})`);
    this.name = "DegradedError";
  }
}

/** Narrow an unknown thrown value to a {@link DegradedError} (the worker's retry/DLQ branch keys on it). */
export function isDegradedError(value: unknown): value is DegradedError {
  return value instanceof DegradedError;
}
