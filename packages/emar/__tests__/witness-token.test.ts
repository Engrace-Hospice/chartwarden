// @wardenx/emar — §7.4 witness-attestation token security — M13-T04.
import { describe, expect, it } from "vitest";
import {
  WITNESS_TOKEN_TTL_MS,
  type WitnessTokenClaims,
  type WitnessTokenScope,
  assertWitnessToken,
  buildWitnessAttestationToken,
  verifyWitnessAttestationToken,
  witnessTokenDigest,
} from "../src/witness";

const SECRET = "tenant-session-token-secret";
const ISSUED_AT = 1_750_000_000_000;

const scope: WitnessTokenScope = {
  patientId: "pat-1",
  medicationOrderId: "ord-1",
  administeringClinicianMembershipId: "mem-admin",
};

const claims: WitnessTokenClaims = {
  ...scope,
  witnessMembershipId: "mem-witness",
  issuedAtMs: ISSUED_AT,
  nonce: "nonce-abc",
};

const tokenFor = (c: WitnessTokenClaims = claims, secret = SECRET): string =>
  buildWitnessAttestationToken(c, secret);

describe("§7.4 verifyWitnessAttestationToken", () => {
  it("accepts a well-formed, in-TTL, in-scope token and returns claims + audit digest", () => {
    const token = tokenFor();
    const r = verifyWitnessAttestationToken({
      token,
      secret: SECRET,
      expectedScope: scope,
      nowMs: ISSUED_AT + 10_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.witnessMembershipId).toBe("mem-witness");
      expect(r.digest).toBe(witnessTokenDigest(token));
    }
  });

  it("rejects a tampered token (HMAC mismatch → WITNESS_TOKEN_INVALID)", () => {
    const token = tokenFor();
    const tampered = `${token.slice(0, -2)}00`;
    expect(
      verifyWitnessAttestationToken({
        token: tampered,
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_INVALID" });
  });

  it("rejects a token signed with a different tenant secret", () => {
    const token = tokenFor(claims, "other-tenant-secret");
    expect(
      verifyWitnessAttestationToken({
        token,
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_INVALID" });
  });

  it("rejects a malformed token (no signature segment)", () => {
    expect(
      verifyWitnessAttestationToken({
        token: "garbage",
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_INVALID" });
  });

  it("rejects a token past the 60-second TTL", () => {
    const token = tokenFor();
    expect(
      verifyWitnessAttestationToken({
        token,
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT + WITNESS_TOKEN_TTL_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_EXPIRED" });
  });

  it("accepts exactly at the TTL boundary and rejects a future-issued token", () => {
    const token = tokenFor();
    expect(
      verifyWitnessAttestationToken({
        token,
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT + WITNESS_TOKEN_TTL_MS,
      }).ok,
    ).toBe(true);
    expect(
      verifyWitnessAttestationToken({
        token,
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT - 1,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_EXPIRED" });
  });

  it("rejects a token minted for a different (patient, order, clinician) scope (§7.4 scope-binding)", () => {
    const token = tokenFor();
    expect(
      verifyWitnessAttestationToken({
        token,
        secret: SECRET,
        expectedScope: { ...scope, patientId: "pat-2" },
        nowMs: ISSUED_AT,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_SCOPE_MISMATCH" });
    expect(
      verifyWitnessAttestationToken({
        token,
        secret: SECRET,
        expectedScope: { ...scope, medicationOrderId: "ord-2" },
        nowMs: ISSUED_AT,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_SCOPE_MISMATCH" });
  });

  it("HMAC is checked before scope (a forged scope on a tampered token reads as invalid, not scope-mismatch)", () => {
    const token = tokenFor();
    const tampered = `${token.slice(0, -2)}ff`;
    expect(
      verifyWitnessAttestationToken({
        token: tampered,
        secret: SECRET,
        expectedScope: { ...scope, patientId: "pat-2" },
        nowMs: ISSUED_AT,
      }),
    ).toEqual({ ok: false, reason: "WITNESS_TOKEN_INVALID" });
  });
});

describe("§7.4 assertWitnessToken", () => {
  it("returns the verified claims + digest on success", () => {
    const token = tokenFor();
    const r = assertWitnessToken({ token, secret: SECRET, expectedScope: scope, nowMs: ISSUED_AT });
    expect(r.claims.witnessMembershipId).toBe("mem-witness");
    expect(r.digest).toBe(witnessTokenDigest(token));
  });
  it("throws the precise 401 code on rejection", () => {
    const token = tokenFor();
    expect(() =>
      assertWitnessToken({
        token,
        secret: SECRET,
        expectedScope: scope,
        nowMs: ISSUED_AT + WITNESS_TOKEN_TTL_MS + 1,
      }),
    ).toThrow(expect.objectContaining({ code: "WITNESS_TOKEN_EXPIRED", statusCode: 401 }));
  });
});
