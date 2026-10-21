import { buildWitnessAttestationToken, verifyWitnessAttestationToken } from "@chartwarden/emar";
/**
 * TASK-008/SEC-001 — the §7.4 witness-attestation HMAC secret is externalized via
 * `M13_WITNESS_SIGNING_KEY`, read once at module load (mirrors `bootstrap/env.ts`'s fail-closed
 * production gate as a defense-in-depth check at the point of use). Two things to prove: production
 * boot refuses to proceed without the key, and a token minted under the dev-fallback secret does not
 * verify against a real externalized secret (the HMAC actually changed, not just the code path).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_KEY = process.env.M13_WITNESS_SIGNING_KEY;

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env values stringify — `= undefined` sets the string "undefined", not an absent key.
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  // biome-ignore lint/performance/noDelete: process.env values stringify — `= undefined` sets the string "undefined", not an absent key.
  if (ORIGINAL_KEY === undefined) delete process.env.M13_WITNESS_SIGNING_KEY;
  else process.env.M13_WITNESS_SIGNING_KEY = ORIGINAL_KEY;
  vi.resetModules();
});

describe("M13 witness signing key (TASK-008)", () => {
  it("refuses to load in production without M13_WITNESS_SIGNING_KEY set", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    // biome-ignore lint/performance/noDelete: process.env values stringify — `= undefined` sets the string "undefined", not an absent key.
    delete process.env.M13_WITNESS_SIGNING_KEY;
    await expect(import("../emar-route-service-db")).rejects.toThrow(
      /M13_WITNESS_SIGNING_KEY is required in production/,
    );
  });

  it("loads in production once M13_WITNESS_SIGNING_KEY is set", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    process.env.M13_WITNESS_SIGNING_KEY = "p".repeat(32);
    await expect(import("../emar-route-service-db")).resolves.toBeDefined();
  });

  it("a token minted under the dev-fallback secret does not verify against a real externalized secret", () => {
    const scope = {
      patientId: "patient-1",
      medicationOrderId: "order-1",
      administeringClinicianMembershipId: "clinician-1",
    };
    const claims = {
      ...scope,
      witnessMembershipId: "witness-1",
      issuedAtMs: Date.now(),
      nonce: "n1",
    };
    const devToken = buildWitnessAttestationToken(
      claims,
      "chartwarden-m13-witness-secret-dev-only-do-not-use-in-prod",
    );
    const result = verifyWitnessAttestationToken({
      token: devToken,
      secret: "a-real-externalized-production-secret-32b",
      expectedScope: scope,
      nowMs: claims.issuedAtMs,
    });
    expect(result).toEqual({ ok: false, reason: "WITNESS_TOKEN_INVALID" });
  });
});
