// Module 28 — §2.2/§2.3/D2 client-auth cores (M28-T03).
//
// The two Phase-1 auth paths and the session gate are the gateway's front door: a verifier that admits a
// forged assertion, a stale bearer, or a scope the client never held is a PHI leak. So these tests mint a
// REAL RS384 assertion against a generated keypair and assert both the happy path and each specific
// refusal (wrong alg, iss/sub confusion, audience confusion, expiry, over-long lifetime, missing jti,
// tampered signature), then the api-key constant-time compare and the session mint/verify invariants.

import { type KeyObject, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { apiKeyFingerprint, verifyApiKey } from "../src/auth/api-key";
import {
  FHIR_ASSERTION_ALG,
  FHIR_ASSERTION_MAX_LIFETIME_MS,
  type FhirJwk,
  verifyClientAssertion,
} from "../src/auth/backend-services";
import {
  FHIR_SESSION_TTL_MS,
  buildSessionMint,
  resolveGrantedScopes,
  verifySession,
} from "../src/auth/session";

// ── test fixtures: a real RSA keypair + a base64url JWT minter ─────────────────────────────────────────

const CLIENT_ID = "client-mercy-hie";
const AUD = "https://fhir.wardenx.com/fhir/oauth2/token";
const NOW = 1_800_000_000_000; // fixed injected clock

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: "jwk" }) as FhirJwk), kid: "kid-1" };

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function mintAssertion(
  payloadOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
  key: KeyObject = privateKey,
): string {
  const header = { alg: FHIR_ASSERTION_ALG, typ: "JWT", kid: "kid-1", ...headerOverrides };
  const payload = {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: AUD,
    exp: Math.floor((NOW + 2 * 60 * 1000) / 1000), // 2 min out — within the 5-min ceiling
    jti: "jti-abc-123",
    ...payloadOverrides,
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = createSign("RSA-SHA384").update(signingInput).sign(key).toString("base64url");
  return `${signingInput}.${signature}`;
}

const baseInput = {
  expectedClientId: CLIENT_ID,
  expectedAudience: AUD,
  jwks: [JWK],
  nowMs: NOW,
};

describe("§D2 SMART Backend Services client-assertion", () => {
  it("accepts a well-formed, correctly-signed assertion and returns its claims", () => {
    const result = verifyClientAssertion({ ...baseInput, assertion: mintAssertion() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.clientId).toBe(CLIENT_ID);
      expect(result.claims.jti).toBe("jti-abc-123");
      expect(result.claims.expiresAtMs).toBe(Math.floor((NOW + 2 * 60 * 1000) / 1000) * 1000);
    }
  });

  it("refuses a non-RS384 alg (algorithm downgrade / alg:none)", () => {
    const r1 = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({}, { alg: "RS256" }),
    });
    expect(r1).toEqual({ ok: false, reason: "UNSUPPORTED_ALG" });
    const r2 = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({}, { alg: "none" }),
    });
    expect(r2).toEqual({ ok: false, reason: "UNSUPPORTED_ALG" });
  });

  it("refuses iss/sub that disagree or name a different client", () => {
    const mismatched = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({ sub: "other" }),
    });
    expect(mismatched).toEqual({ ok: false, reason: "ISS_SUB_MISMATCH" });
    const impersonation = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({ iss: "attacker", sub: "attacker" }),
    });
    expect(impersonation).toEqual({ ok: false, reason: "ISS_SUB_MISMATCH" });
  });

  it("refuses an assertion minted for a different token endpoint (audience confusion)", () => {
    const result = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({ aud: "https://partner.example/token" }),
    });
    expect(result).toEqual({ ok: false, reason: "AUDIENCE_MISMATCH" });
  });

  it("accepts an array-form aud that includes this endpoint", () => {
    const result = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({ aud: ["https://other/token", AUD] }),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses an expired assertion (beyond skew) and an over-long lifetime", () => {
    const expired = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({ exp: Math.floor((NOW - 5 * 60 * 1000) / 1000) }),
    });
    expect(expired).toEqual({ ok: false, reason: "ASSERTION_EXPIRED" });

    const tooLong = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({
        exp: Math.floor((NOW + FHIR_ASSERTION_MAX_LIFETIME_MS + 60_000) / 1000),
      }),
    });
    expect(tooLong).toEqual({ ok: false, reason: "ASSERTION_LIFETIME_TOO_LONG" });
  });

  it("refuses an assertion with no jti (un-dedupable ⇒ replayable)", () => {
    const result = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({ jti: undefined }),
    });
    expect(result).toEqual({ ok: false, reason: "MISSING_JTI" });
  });

  it("refuses when the header kid names no key in the resolved JWKS", () => {
    const result = verifyClientAssertion({
      ...baseInput,
      assertion: mintAssertion({}, { kid: "kid-unknown" }),
    });
    expect(result).toEqual({ ok: false, reason: "NO_MATCHING_JWK" });
  });

  it("refuses a signature made with the wrong private key", () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = mintAssertion({}, {}, attacker.privateKey);
    const result = verifyClientAssertion({ ...baseInput, assertion: forged });
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("refuses a structurally malformed assertion", () => {
    expect(verifyClientAssertion({ ...baseInput, assertion: "not-a-jwt" })).toEqual({
      ok: false,
      reason: "MALFORMED_ASSERTION",
    });
  });
});

describe("§2.2 api-key credential", () => {
  it("fingerprints the first 8 hex chars of the secret's sha256, deterministically", () => {
    const fp = apiKeyFingerprint("super-secret-key");
    expect(fp).toHaveLength(8);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(apiKeyFingerprint("super-secret-key")).toBe(fp);
    expect(apiKeyFingerprint("other-key")).not.toBe(fp);
  });

  it("verifies an exact match and refuses a mismatch or an empty presented key", () => {
    expect(verifyApiKey("the-key", "the-key")).toBe(true);
    expect(verifyApiKey("the-key", "different")).toBe(false);
    expect(verifyApiKey("", "the-key")).toBe(false);
    expect(verifyApiKey("the-key", "")).toBe(false);
  });
});

describe("§2.3 session scope resolution + §2.4 verification", () => {
  const ALLOWED = ["system/Patient.read", "system/Observation.read"];

  it("grants a subset request and refuses a broader one, naming the deviating scopes", () => {
    expect(resolveGrantedScopes(["system/Patient.read"], ALLOWED)).toEqual({
      ok: true,
      granted: ["system/Patient.read"],
    });
    expect(resolveGrantedScopes(["system/Patient.read", "system/Encounter.read"], ALLOWED)).toEqual(
      {
        ok: false,
        invalidScopes: ["system/Encounter.read"],
      },
    );
  });

  it("mints a session whose expiry is issued_at + 15min, server-derived", () => {
    const session = buildSessionMint({
      clientId: CLIENT_ID,
      jti: "sess-1",
      scopesGranted: ["system/Patient.read"],
      issuedAtMs: NOW,
    });
    expect(session.expiresAtMs).toBe(NOW + FHIR_SESSION_TTL_MS);
  });

  it("serves a live session, refuses an expired one, and refuses a revoked one still in TTL", () => {
    const session = buildSessionMint({
      clientId: CLIENT_ID,
      jti: "sess-1",
      scopesGranted: ["system/Patient.read"],
      issuedAtMs: NOW,
    });
    const live = verifySession(session, NOW + 60_000);
    expect(live.ok).toBe(true);

    expect(verifySession(session, NOW + FHIR_SESSION_TTL_MS)).toEqual({
      ok: false,
      reason: "SESSION_EXPIRED",
    });

    // Revoked one minute ago, still well inside the 15-minute TTL — the revoke wins.
    expect(verifySession(session, NOW + 5 * 60_000, NOW + 4 * 60_000)).toEqual({
      ok: false,
      reason: "SESSION_REVOKED",
    });
  });
});
