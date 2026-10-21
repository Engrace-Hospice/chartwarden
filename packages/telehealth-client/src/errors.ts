// @chartwarden/telehealth-client — the typed adapter-failure contract (M31-T05, spec §4.5 D1 / §7.3 D14).
//
// Per WARDENX_INTEGRATIONS + the architecture §25.14 adapter mandate a raw `fetch` rejection must NEVER
// propagate to an M31 caller: every telehealth-vendor transport failure is normalised to this five-field
// `TelehealthDegradedError` envelope so the route layer (M31-T07) decides the §7.3 Tier-3 degraded path
// (offer audio-only, then reschedule-in-person via M17) from `retryable` alone, and so an out-of-band alert
// (M36 `telehealth_vendor_outage`, §4.9) carries ONLY the vendor / operation / correlation id — never PHI.
// Mirrors the M10 iqies-client `DegradedError` / M17 routing-client `RoutingDegradedError` precedent.
//
// PHI boundary (D1): the error carries the operation + a PHI-free correlation id — never a patient/clinician
// name, MRN, condition, room contents, or recording bytes. The adapter never logs request bodies in clear.

/** The vendor operations that can degrade (the sync `verifyWebhookSignature` never throws — it returns a bool). */
export type TelehealthOperation =
  | "mintRoom"
  | "mintParticipantToken"
  | "endRoom"
  | "startRecording"
  | "stopRecording";

/** The vendors an adapter can front (mirrors `TelehealthProviderVendor` / the `telehealth_vendor` pgEnum). */
export type TelehealthDegradedVendor = "daily_co" | "twilio_video" | "native_webrtc";

/**
 * §4.5 / §7.3 — the Tier-3 degraded envelope. `retryable: true` covers 429 / 5xx / network timeouts / an
 * open circuit (the route offers audio-only or retries); `retryable: false` covers a permanent vendor
 * rejection or a not-enabled scaffold adapter (the visit is documented as attempted per §7.3). `vendorMessage`
 * is PHI-free + human-readable; `correlationId` ties the failure to the adapter's structured log without
 * exposing the request (which is PHI-free anyway).
 */
export class TelehealthDegradedError extends Error {
  constructor(
    public readonly vendor: TelehealthDegradedVendor, // field 1 — which vendor
    public readonly operation: TelehealthOperation, // field 2 — which operation failed
    public readonly retryable: boolean, // field 3 — transient vs permanent
    public readonly vendorMessage: string, // field 4 — human-readable, no PHI
    public readonly correlationId: string, // field 5 — request correlation UUID
  ) {
    super(`[${vendor}/${operation}] ${vendorMessage} (correlationId=${correlationId})`);
    this.name = "TelehealthDegradedError";
  }
}

/** Narrow an unknown thrown value to a {@link TelehealthDegradedError} (the route's degrade branch keys on it). */
export function isTelehealthDegradedError(value: unknown): value is TelehealthDegradedError {
  return value instanceof TelehealthDegradedError;
}
