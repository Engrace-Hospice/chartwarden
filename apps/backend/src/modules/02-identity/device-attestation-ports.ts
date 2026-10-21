// apps/backend/src/modules/02-identity/device-attestation-ports.ts — M2, SecHardening §12.2/§12.4.
//
// The ports behind the device-attestation surface ADR-0023 D2 adjudicated onto M2. The route layer
// depends on these; the Drizzle store and the HMAC verifier implement them; tests substitute in-memory
// ones. Same split as the step-up subsystem next door, for the same reason: the DECISION (does this
// assertion prove the device?) is pure and unit-testable, the WRITE is not.
//
// WHAT THE PLATFORM IS ACTUALLY VERIFYING. A device cannot vouch for itself — SecHardening §12.4's
// jailbreak/root detection runs ON the device, so the answer arrives from the party being judged. What
// makes the row the PLATFORM's verdict is that the assertion is authenticated: the reported posture is
// covered by an HMAC the server recomputes over a nonce the SERVER minted, keyed by a secret the server
// holds. An attacker who cannot produce that MAC cannot enrol a device, and one who replays a captured
// assertion meets a nonce that has already been spent. The `provider` column records which class of
// evidence a row rests on, so a reviewer can tell a managed-fleet enrolment from a hardware attestation
// rather than having to assume.
import type { DeviceAttestationPosture } from "@chartwarden/types";

/**
 * The session facts the device routes act on, resolved SERVER-side from `request.context`.
 *
 * Deliberately not M2's `AuthenticatedSession`: that one carries the step-up state, which these routes
 * have no business in, and reusing it would have meant inventing a `lastStepUpAt` for a resolver that
 * has no way to know one. Narrow is the point — the org and the membership here are what bind an
 * attestation to a person, so the fewer fields that can be wrong, the better.
 */
export interface DeviceAttestationSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
}

/** The mobile platforms an attestation can cover (mirrors the `device_attestation_platform` enum). */
export type DeviceAttestationPlatform = "ios" | "android";

/** What the verdict rests on (mirrors the `device_attestation_provider` enum). */
export type DeviceAttestationProvider =
  | "managed_enrollment"
  | "apple_app_attest"
  | "google_play_integrity";

/** A minted, single-use challenge. `nonce` is what the device MACs; `id` is what it echoes back. */
export interface DeviceAttestationChallenge {
  readonly sessionId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly nonce: string;
  readonly createdAt: string;
}

/** The single-use challenge store (Redis in production, in-memory in the slice). */
export interface DeviceAttestationChallengeStore {
  put(id: string, challenge: DeviceAttestationChallenge, ttlSec: number): Promise<void>;
  /** Read AND spend in one step. A challenge is single-use: the second read of an id returns null,
   *  which is what makes a captured assertion unreplayable. */
  take(id: string): Promise<DeviceAttestationChallenge | null>;
}

/** What the device submits. Every field except `assertion` is covered by the MAC. */
export interface DeviceAttestationAssertion {
  readonly deviceKeyFingerprint: string;
  readonly platform: DeviceAttestationPlatform;
  readonly provider: DeviceAttestationProvider;
  readonly posture: DeviceAttestationPosture;
  /** The provider-specific proof: the base64 HMAC for `managed_enrollment`, a vendor blob otherwise. */
  readonly assertion: string;
}

/** The verifier's answer. `ok: false` is a RECORDED failure, not an error — it writes a `failed` row. */
export type DeviceAttestationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }
  /** The provider's verification path is not installed in this deployment. Distinct from a failure:
   *  nothing was proved and nothing was disproved, so no `failed` row is written and the caller gets a
   *  501 rather than a rejection it could mistake for "this device is compromised". */
  | { readonly ok: false; readonly reason: string; readonly unavailable: true };

/**
 * Verifies one attestation assertion against the challenge the server minted for it.
 *
 * Deliberately NOT given the request: everything it needs is either the assertion or the challenge, so
 * there is no path by which a header or a query parameter can influence a device-integrity decision.
 */
export interface DeviceAttestationVerifier {
  verify(input: {
    readonly challenge: DeviceAttestationChallenge;
    readonly assertion: DeviceAttestationAssertion;
  }): Promise<DeviceAttestationVerdict>;
}

/** One persisted attestation, as the store returns it. */
export interface DeviceAttestationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly deviceKeyFingerprint: string;
  readonly platform: DeviceAttestationPlatform;
  readonly provider: DeviceAttestationProvider;
  readonly verdict: "attested" | "failed" | "revoked";
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** The write surface over `device_attestation` (+ the session's pointer at it). */
export interface DeviceAttestationStore {
  /** Record a PASS: revoke any live attestation for the same device, insert the new row, and point the
   *  session at it — one transaction, because a session pointing at a superseded row is the state the
   *  partial unique index exists to make impossible. */
  recordAttested(input: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly sessionId: string;
    readonly deviceKeyFingerprint: string;
    readonly platform: DeviceAttestationPlatform;
    readonly provider: DeviceAttestationProvider;
    readonly posture: DeviceAttestationPosture;
    readonly verifiedAt: Date;
    readonly expiresAt: Date;
  }): Promise<DeviceAttestationRecord>;

  /** Record a FAILURE. Retained rather than dropped: repeated failures from one device are the signal
   *  SecHardening §12.4's "combined with audit at server side" is asking for. Never binds the session. */
  recordFailed(input: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly deviceKeyFingerprint: string;
    readonly platform: DeviceAttestationPlatform;
    readonly provider: DeviceAttestationProvider;
    readonly posture: DeviceAttestationPosture;
    readonly failureReason: string;
    readonly verifiedAt: Date;
    readonly expiresAt: Date;
  }): Promise<DeviceAttestationRecord>;

  /** Revoke a live attestation and clear it from any session pointing at it, so a lost device stops
   *  satisfying the gate on the NEXT request rather than at its next re-attestation. */
  revoke(input: {
    readonly organizationId: string;
    readonly attestationId: string;
    readonly revokedByMembershipId: string;
    readonly reason: string;
  }): Promise<DeviceAttestationRecord | null>;

  /** The org's attestations for one membership (the admin review list). */
  listForMembership(input: {
    readonly organizationId: string;
    readonly membershipId: string;
  }): Promise<readonly DeviceAttestationRecord[]>;
}
