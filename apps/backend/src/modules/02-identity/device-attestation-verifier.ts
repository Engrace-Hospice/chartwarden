// apps/backend/src/modules/02-identity/device-attestation-verifier.ts — M2, SecHardening §12.2/§12.4.
//
// The `managed_enrollment` verifier, plus the §12.2 posture policy every provider is judged against.
//
// WHY THIS IS A REAL VERIFICATION AND NOT A STUB. The device reports its own posture — §12.4's
// jailbreak detection runs on the handset, so it has to. What the server contributes is that it will not
// BELIEVE the report unless it arrives under an HMAC the server can recompute, over a nonce the server
// minted moments earlier and has already spent. Three properties follow, and they are the whole
// assurance argument:
//
//   - UNFORGEABLE: the MAC key derives from a platform secret the device never sees, so a caller who can
//     reach the route but not the secret cannot enrol anything.
//   - UNREPLAYABLE: the nonce is single-use (`take`, not `get`), so a captured assertion is spent.
//   - UNMALLEABLE: the MAC covers the fingerprint, platform, provider AND the posture, so an attacker
//     who intercepts a genuine assertion cannot flip `jailbrokenOrRooted` to false in flight.
//
// PER-ORG KEY DERIVATION. One platform secret is operated, and each org's MAC key is
// HMAC(secret, "device-attestation:" + orgId). A secret leaked from one tenant's MDM profile therefore
// cannot enrol devices into another tenant, and the platform still has one value to rotate.
//
// WHEN THE SECRET IS UNSET the verifier reports `unavailable` rather than failing. Those are different
// answers and the route sends different statuses: "this deployment does not do device enrolment" is a
// 501, "this device did not prove itself" is a 401 plus a recorded `failed` row. Collapsing them would
// make an unconfigured deployment look like a fleet of compromised handsets.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeviceAttestationPosture } from "@chartwarden/types";
import type {
  DeviceAttestationAssertion,
  DeviceAttestationChallenge,
  DeviceAttestationVerdict,
  DeviceAttestationVerifier,
} from "./device-attestation-ports";

/** The env var carrying the platform enrolment secret. Absent means managed enrolment is not offered. */
export const DEVICE_ENROLLMENT_SECRET_ENV = "DEVICE_ENROLLMENT_SECRET";

/** §12.2 minimum OS versions. A device below the floor is refused, not warned about. */
const MIN_OS_MAJOR: Readonly<Record<string, number>> = { ios: 16, android: 12 };

/**
 * Apply the §12.2 device-posture policy. Returns null when the device passes, or the reason it did not.
 *
 * UNREPORTED IS UNMET, deliberately. A provider that cannot answer "is the screen lock on?" has not
 * told us it is off — but a posture check whose requirements evaporate when the reporter stays quiet is
 * satisfiable by saying nothing, which is the cheapest possible attack on it.
 */
export function posturePolicyFailure(
  platform: string,
  posture: DeviceAttestationPosture,
): string | null {
  if (posture.jailbrokenOrRooted === true) return "device_compromised";
  if (posture.emulator === true) return "emulator_refused";
  if (posture.biometricAvailable !== true) return "biometric_unavailable";
  if (posture.screenLockEnabled !== true) return "screen_lock_disabled";
  const floor = MIN_OS_MAJOR[platform];
  if (floor === undefined) return "unsupported_platform";
  const major = Number.parseInt(String(posture.osVersion ?? "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) return "os_version_unreported";
  if (major < floor) return "os_version_below_floor";
  return null;
}

/**
 * The bytes the MAC covers. Field-separated with a character none of the fields may contain, so two
 * different assertions cannot serialize to the same string — the classic concatenation confusion where
 * `a` + `bc` and `ab` + `c` produce one payload.
 */
export function attestationMacPayload(
  challenge: DeviceAttestationChallenge,
  assertion: DeviceAttestationAssertion,
): string {
  return [
    challenge.nonce,
    challenge.organizationId,
    challenge.membershipId,
    assertion.deviceKeyFingerprint,
    assertion.platform,
    assertion.provider,
    // Canonical, key-sorted JSON: two objects with the same facts in a different key order must MAC to
    // the same value, or a device that reorders its own payload fails for no reason.
    JSON.stringify(
      Object.fromEntries(Object.entries(assertion.posture).sort(([a], [b]) => a.localeCompare(b))),
    ),
  ].join(" ");
}

/** The org's MAC key, derived from the platform secret so one value is operated and rotated. */
export function orgEnrollmentKey(platformSecret: string, organizationId: string): Buffer {
  return createHmac("sha256", platformSecret)
    .update(`device-attestation:${organizationId}`)
    .digest();
}

/**
 * Build the `managed_enrollment` verifier. `secret` defaults to the env var; pass it explicitly in
 * tests. The two hardware providers are NOT implemented here — they need a vendor round trip
 * (App Attest / Play Integrity) — and report `unavailable` rather than denying, so a deployment that
 * has not installed that adapter stays distinguishable from one whose devices are failing.
 */
export function createManagedEnrollmentVerifier(
  secret: string | undefined = process.env[DEVICE_ENROLLMENT_SECRET_ENV],
): DeviceAttestationVerifier {
  return {
    async verify({ challenge, assertion }): Promise<DeviceAttestationVerdict> {
      if (assertion.provider !== "managed_enrollment") {
        return {
          ok: false,
          unavailable: true,
          reason: `provider_not_installed:${assertion.provider}`,
        };
      }
      if (!secret) {
        return { ok: false, unavailable: true, reason: "managed_enrollment_not_configured" };
      }

      // MAC first, policy second. The posture is only worth judging once we know it is the posture the
      // device actually sent; judging it first would let an attacker map the policy by probing it with
      // unauthenticated payloads.
      const expected = createHmac("sha256", orgEnrollmentKey(secret, challenge.organizationId))
        .update(attestationMacPayload(challenge, assertion))
        .digest();
      const supplied = Buffer.from(assertion.assertion, "base64");
      // Length-check before `timingSafeEqual`, which THROWS on a length mismatch rather than returning
      // false. An uncaught throw here would surface as a 500 and turn a bad MAC into an outage.
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return { ok: false, reason: "assertion_signature_invalid" };
      }

      const failure = posturePolicyFailure(assertion.platform, assertion.posture);
      if (failure) return { ok: false, reason: failure };
      return { ok: true };
    },
  };
}
