// @wardenx/telehealth-client — the vendor-adapter contract (M31 §4.5 D1; M31-T01 layout).
//
// The `TelehealthProvider` interface is the ONLY boundary M31 crosses to a telehealth vendor. Per the D1
// PHI-minimization rule every input is PHI-free — no patient name, no clinician name, no MRN, no condition:
// the vendor sees only the M31-owned opaque `telehealthVisitId`, an ISO start time (for room TTL), and an
// opaque participant kind. The concrete adapters (`daily-co-adapter.ts` active by default; Twilio Video +
// native WebRTC scaffold-only behind the same interface), the circuit breaker (Architecture §25.14) and the
// webhook signature verifier land in M31-T05; this file is the type-only contract they conform to.

/** The set of vendors an adapter can front (mirrors the `telehealth_vendor` pgEnum). */
export type TelehealthProviderVendor = "daily_co" | "twilio_video" | "native_webrtc";

/** A participant kind is opaque to the vendor — never the real identity (D1). */
export type TelehealthParticipantKind = "patient" | "clinician";

/** Input to {@link TelehealthProvider.mintRoom}. Idempotent on `telehealthVisitId`. PHI-free. */
export interface TelehealthMintRoomInput {
  /** M31-owned, opaque to the vendor. */
  readonly telehealthVisitId: string;
  /** ISO instant; the vendor uses this only for room TTL. */
  readonly scheduledStartedAt: string;
  readonly recordingEnabled: boolean;
}

/** Input to {@link TelehealthProvider.mintParticipantToken}. */
export interface TelehealthMintParticipantTokenInput {
  readonly vendorRoomId: string;
  readonly participantKind: TelehealthParticipantKind;
  /** Platform floor 1800 (30 min), ceiling 7200 (2h). */
  readonly ttlSeconds: number;
}

/**
 * The D1 telehealth vendor adapter contract. The adapter wraps the circuit breaker and emits a
 * `DegradedError` on outage. Daily.co ships enabled by default; the other two ship as scaffold-only behind
 * this same interface with a compile-time conformance test (M31-T05).
 */
export interface TelehealthProvider {
  readonly vendor: TelehealthProviderVendor;

  /** Idempotent on `telehealthVisitId`; returns the same room metadata on replay. */
  mintRoom(
    input: TelehealthMintRoomInput,
  ): Promise<{ vendorRoomId: string; vendorRoomUrl: string }>;

  /** Mint a per-participant short-TTL token; the vendor never sees actual identity. */
  mintParticipantToken(
    input: TelehealthMintParticipantTokenInput,
  ): Promise<{ token: string; expiresAt: string }>;

  /** Force-end a room (server-side close). */
  endRoom(vendorRoomId: string): Promise<void>;

  /** Start recording on an active room. */
  startRecording(vendorRoomId: string): Promise<{ vendorRecordingId: string }>;

  /** Stop recording on an active room. */
  stopRecording(
    vendorRoomId: string,
    vendorRecordingId: string,
  ): Promise<{ recordingUrl: string; durationSec: number }>;

  /** Verify an inbound webhook signature. */
  verifyWebhookSignature(headers: Record<string, string>, rawBody: string): boolean;
}
