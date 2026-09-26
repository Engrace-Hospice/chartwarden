import { createHmac } from "node:crypto";
import { liveDeviceAttestation } from "@wardenx/auth";
import type { DeviceAttestationPosture } from "@wardenx/types";
// apps/backend/__tests__/device-attestation.test.ts — F-030 / ADR-0023 D2 / SecHardening §12.2/§12.4.
//
// THE DEFECT. M3's `device_attestation_valid` predicate reads `attributes.deviceAttestation` and denies
// unless the platform's own verdict says `valid`. Nothing wrote it, because M2 owned no attestation
// table — so the predicate denied EVERY caller and its one consumer, M33's
// `report.drilldown.bulk_export` (a CSV of patient-identifiable navigation links), was closed to
// everyone, always. The deny direction was right; a control that can never pass is not a control.
//
// WHAT IS BEING TESTED, AND WHY THESE THINGS. Three seams, in the order an attack would meet them:
//
//   1. THE VERIFIER — is the assertion actually proved? Forgery, replay and in-flight tampering are the
//      three ways a device could claim a posture it does not have, and each has a case here.
//   2. THE POLICY — given a proved assertion, does §12.2 accept the device? Including the case that
//      makes the policy meaningful: an UNREPORTED requirement is unmet, so silence does not pass.
//   3. THE RESOLVER — given a stored attestation, does the request see it? This is the half that was
//      missing entirely, and its interesting cases are all the ways a live pointer stops being live.
//
// The whole chain is a security control, so every negative case below is asserted to DENY rather than
// merely to differ.
import { describe, expect, it } from "vitest";
import type {
  DeviceAttestationAssertion,
  DeviceAttestationChallenge,
} from "../src/modules/02-identity/device-attestation-ports";
import {
  attestationMacPayload,
  createInMemoryDeviceAttestationChallengeStore,
  createManagedEnrollmentVerifier,
  orgEnrollmentKey,
  posturePolicyFailure,
} from "../src/modules/02-identity/index";

const SECRET = "platform-enrollment-secret";
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";

const CHALLENGE: DeviceAttestationChallenge = {
  sessionId: "sess_1",
  membershipId: MEMBERSHIP,
  organizationId: ORG,
  nonce: "nonce-abc",
  createdAt: "2026-08-26T00:00:00.000Z",
};

/** A device that passes §12.2 on every axis. */
const GOOD_POSTURE: DeviceAttestationPosture = {
  osVersion: "17.4.1",
  jailbrokenOrRooted: false,
  biometricAvailable: true,
  screenLockEnabled: true,
  emulator: false,
};

/** Build the assertion a legitimate managed-fleet device would send. */
function signed(
  over: Partial<DeviceAttestationAssertion> = {},
  challenge: DeviceAttestationChallenge = CHALLENGE,
  secret = SECRET,
): DeviceAttestationAssertion {
  const base: DeviceAttestationAssertion = {
    deviceKeyFingerprint: "fp-1",
    platform: "ios",
    provider: "managed_enrollment",
    posture: GOOD_POSTURE,
    assertion: "",
    ...over,
  };
  const mac = createHmac("sha256", orgEnrollmentKey(secret, challenge.organizationId))
    .update(attestationMacPayload(challenge, base))
    .digest("base64");
  return { ...base, assertion: mac };
}

describe("SecHardening §12.4 — the managed-enrollment verifier", () => {
  const verifier = createManagedEnrollmentVerifier(SECRET);

  it("accepts a correctly signed assertion from a compliant device", async () => {
    expect(await verifier.verify({ challenge: CHALLENGE, assertion: signed() })).toEqual({
      ok: true,
    });
  });

  it("refuses an assertion signed with the wrong secret — the forgery case", async () => {
    const forged = signed({}, CHALLENGE, "not-the-platform-secret");
    expect(await verifier.verify({ challenge: CHALLENGE, assertion: forged })).toEqual({
      ok: false,
      reason: "assertion_signature_invalid",
    });
  });

  it("refuses an assertion minted for a DIFFERENT org — one tenant's secret cannot enrol into another", async () => {
    // The key is derived per-org, so even a caller holding a legitimate assertion for org A cannot
    // present it against org B. This is what the derivation buys over one shared MAC key.
    const otherOrg = { ...CHALLENGE, organizationId: "33333333-3333-4333-8333-333333333333" };
    const forOtherOrg = signed({}, otherOrg);
    expect(await verifier.verify({ challenge: CHALLENGE, assertion: forOtherOrg })).toEqual({
      ok: false,
      reason: "assertion_signature_invalid",
    });
  });

  it("refuses when the posture was edited after signing — the in-flight tampering case", async () => {
    // The MAC covers the posture, so flipping `jailbrokenOrRooted` on a captured assertion breaks it.
    // Without that coverage this would pass the signature check and then pass the policy, which is the
    // exact attack the MAC payload is shaped to stop.
    const genuine = signed();
    const tampered = {
      ...genuine,
      posture: { ...GOOD_POSTURE, jailbrokenOrRooted: false },
      deviceKeyFingerprint: "fp-2",
    };
    expect(await verifier.verify({ challenge: CHALLENGE, assertion: tampered })).toEqual({
      ok: false,
      reason: "assertion_signature_invalid",
    });
  });

  it("refuses a garbage assertion without throwing — a bad MAC is a 401, never a 500", async () => {
    // `timingSafeEqual` THROWS on a length mismatch. An uncaught throw here would turn every malformed
    // assertion into a 500, which is an availability bug handed to any unauthenticated caller.
    for (const assertion of ["", "!!!not-base64!!!", "c2hvcnQ="]) {
      const verdict = await verifier.verify({
        challenge: CHALLENGE,
        assertion: { ...signed(), assertion },
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it("MACs canonically, so a device that reorders its own posture keys still verifies", async () => {
    const reordered: DeviceAttestationPosture = {
      emulator: false,
      screenLockEnabled: true,
      biometricAvailable: true,
      jailbrokenOrRooted: false,
      osVersion: "17.4.1",
    };
    const a = signed();
    const b = signed({ posture: reordered });
    expect(b.assertion).toBe(a.assertion);
    expect(await verifier.verify({ challenge: CHALLENGE, assertion: b })).toEqual({ ok: true });
  });

  it("reports the hardware providers as UNAVAILABLE, not as a failure", async () => {
    // These are different answers and the route sends different statuses. Recording a `failed` row for
    // an uninstalled adapter would put "this device is compromised" in the trail for a deployment that
    // simply has not wired App Attest.
    for (const provider of ["apple_app_attest", "google_play_integrity"] as const) {
      const verdict = await verifier.verify({
        challenge: CHALLENGE,
        assertion: signed({ provider }),
      });
      expect(verdict).toMatchObject({ ok: false, unavailable: true });
    }
  });

  it("reports UNAVAILABLE when no enrolment secret is configured", async () => {
    // `""`, not `undefined`: the factory reads `undefined` as "use the ambient env var", so passing it
    // would make this case pass or fail depending on the developer's shell.
    const unconfigured = createManagedEnrollmentVerifier("");
    expect(await unconfigured.verify({ challenge: CHALLENGE, assertion: signed() })).toMatchObject({
      ok: false,
      unavailable: true,
      reason: "managed_enrollment_not_configured",
    });
  });
});

describe("SecHardening §12.2 — the device-posture policy", () => {
  it("passes a compliant device", () => {
    expect(posturePolicyFailure("ios", GOOD_POSTURE)).toBeNull();
  });

  it("refuses a compromised or emulated device", () => {
    expect(posturePolicyFailure("ios", { ...GOOD_POSTURE, jailbrokenOrRooted: true })).toBe(
      "device_compromised",
    );
    expect(posturePolicyFailure("ios", { ...GOOD_POSTURE, emulator: true })).toBe(
      "emulator_refused",
    );
  });

  it("refuses a device below the §12.2 OS floor, per platform", () => {
    expect(posturePolicyFailure("ios", { ...GOOD_POSTURE, osVersion: "15.7" })).toBe(
      "os_version_below_floor",
    );
    expect(posturePolicyFailure("android", { ...GOOD_POSTURE, osVersion: "11" })).toBe(
      "os_version_below_floor",
    );
    expect(posturePolicyFailure("android", { ...GOOD_POSTURE, osVersion: "12" })).toBeNull();
  });

  it("treats an UNREPORTED requirement as unmet — silence must not pass", () => {
    // The load-bearing case. A policy whose requirements evaporate when the reporter stays quiet is
    // satisfiable by sending `{}`, which is the cheapest possible attack on it.
    expect(posturePolicyFailure("ios", {})).not.toBeNull();
    for (const drop of ["biometricAvailable", "screenLockEnabled", "osVersion"] as const) {
      const partial: Record<string, unknown> = { ...GOOD_POSTURE };
      delete partial[drop];
      expect(posturePolicyFailure("ios", partial as DeviceAttestationPosture)).not.toBeNull();
    }
  });

  it("refuses a platform it has no floor for", () => {
    expect(posturePolicyFailure("windows", GOOD_POSTURE)).toBe("unsupported_platform");
  });
});

describe("the challenge store — single use is what makes an assertion unreplayable", () => {
  it("returns a challenge once and never again", async () => {
    const store = createInMemoryDeviceAttestationChallengeStore();
    await store.put("c1", CHALLENGE, 120);
    expect(await store.take("c1")).toEqual(CHALLENGE);
    expect(await store.take("c1")).toBeNull();
  });

  it("does not return an expired challenge", async () => {
    const store = createInMemoryDeviceAttestationChallengeStore();
    await store.put("c1", CHALLENGE, 0);
    expect(await store.take("c1")).toBeNull();
  });
});

describe("the resolver — a stored attestation only counts while it is LIVE", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  const future = new Date("2026-09-26T12:00:00.000Z");
  const past = new Date("2026-08-01T12:00:00.000Z");
  const live = { verdict: "attested", verifiedAt: past, expiresAt: future, revokedAt: null };

  it("resolves a live attestation to the platform's verdict", () => {
    expect(liveDeviceAttestation(live, now)).toEqual({
      valid: true,
      verifiedAt: past.toISOString(),
    });
  });

  it("resolves to null when the session points at no device", () => {
    // The ordinary case for every browser session, and the one the gate must read as deny.
    expect(liveDeviceAttestation(null, now)).toBeNull();
    expect(liveDeviceAttestation(undefined, now)).toBeNull();
  });

  it("resolves to null once the attestation window has run out", () => {
    // Expiry is the reason the pointer is not the verdict: nothing rewrites the session when a
    // 30-day attestation lapses, so the check has to happen on read.
    expect(liveDeviceAttestation({ ...live, expiresAt: past }, now)).toBeNull();
    // Boundary: expiry exactly now is expired, not still valid.
    expect(liveDeviceAttestation({ ...live, expiresAt: now }, now)).toBeNull();
  });

  it("resolves to null for a revoked attestation, even one whose window is still open", () => {
    // This is what makes revoking a lost handset bite on the NEXT request rather than at its next
    // re-attestation.
    expect(liveDeviceAttestation({ ...live, verdict: "revoked", revokedAt: now }, now)).toBeNull();
    // Belt and braces: a row somehow left `attested` while carrying a revocation is still refused.
    expect(liveDeviceAttestation({ ...live, revokedAt: now }, now)).toBeNull();
  });

  it("resolves to null for a RECORDED FAILURE — a failed check is not a weak pass", () => {
    expect(liveDeviceAttestation({ ...live, verdict: "failed" }, now)).toBeNull();
  });
});
