// apps/backend/__tests__/m24-credential-crypto.test.ts — M24 §8.7 trading-partner secret envelope crypto.
//
// Locks the properties the placeholder violated. Before this, `upsertCredential` wrote the literal string
// "ENC:deferred" into `client_secret_cipher`: the submitted secret was DISCARDED while `hasClientSecret`
// went on reporting true, so the admin screen showed "Set" for a secret that did not exist. The tests below
// pin the three things that must now hold — the secret round-trips, it is tenant-bound, and a legacy
// placeholder row reports the truth rather than a comfortable lie.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  LEGACY_DEFERRED_SENTINEL,
  buildCredentialCipherPort,
  deriveOrgCredentialDek,
  isUsableCipher,
  loadCredentialKek,
  openCredentialSecret,
  sealCredentialSecret,
} from "../src/modules/24-billing-medicaid/credential-crypto";

const KEK = Buffer.alloc(32, 7);
const KEK_B64 = KEK.toString("base64");
const ORG_A = "a0000000-0000-4000-8000-0000000000aa";
const ORG_B = "b0000000-0000-4000-8000-0000000000bb";
const SECRET = "tp-client-secret-9f3a::not-a-real-credential";

describe("M24 §8.7 credential envelope crypto", () => {
  it("round-trips a secret under the tenant DEK", () => {
    const dek = deriveOrgCredentialDek(KEK, ORG_A);
    const cipher = sealCredentialSecret(SECRET, dek);
    expect(openCredentialSecret(cipher, dek)).toBe(SECRET);
  });

  it("never stores the plaintext — the envelope contains no readable secret", () => {
    const cipher = sealCredentialSecret(SECRET, deriveOrgCredentialDek(KEK, ORG_A));
    expect(cipher).not.toContain(SECRET);
    expect(Buffer.from(cipher, "base64").toString("utf8")).not.toContain("tp-client-secret");
  });

  it("uses a fresh nonce per seal, so the same secret never yields the same ciphertext", () => {
    const dek = deriveOrgCredentialDek(KEK, ORG_A);
    expect(sealCredentialSecret(SECRET, dek)).not.toBe(sealCredentialSecret(SECRET, dek));
  });

  it("is tenant-bound — another org's DEK cannot open the cipher", () => {
    const cipher = sealCredentialSecret(SECRET, deriveOrgCredentialDek(KEK, ORG_A));
    expect(() => openCredentialSecret(cipher, deriveOrgCredentialDek(KEK, ORG_B))).toThrow();
  });

  it("detects tampering — a flipped ciphertext byte fails the GCM tag", () => {
    const dek = deriveOrgCredentialDek(KEK, ORG_A);
    const raw = Buffer.from(sealCredentialSecret(SECRET, dek), "base64");
    // Flip a bit inside the ciphertext body (past the 1-byte version + 12-byte nonce header).
    const target = raw[20] ?? 0;
    raw[20] = target ^ 0xff;
    expect(() => openCredentialSecret(raw.toString("base64"), dek)).toThrow();
  });

  it("refuses to open the legacy placeholder instead of returning an empty secret", () => {
    const dek = deriveOrgCredentialDek(KEK, ORG_A);
    expect(() => openCredentialSecret(LEGACY_DEFERRED_SENTINEL, dek)).toThrow(/no usable secret/);
  });

  it("reports the legacy placeholder as NOT configured — the presence flag must not lie", () => {
    expect(isUsableCipher(LEGACY_DEFERRED_SENTINEL)).toBe(false);
    expect(isUsableCipher(null)).toBe(false);
    expect(isUsableCipher("")).toBe(false);
    expect(isUsableCipher(sealCredentialSecret(SECRET, deriveOrgCredentialDek(KEK, ORG_A)))).toBe(
      true,
    );
  });

  it("fails closed on a missing or wrong-length KEK rather than defaulting to a zero key", () => {
    expect(() => loadCredentialKek(undefined)).toThrow(/required/);
    expect(() => loadCredentialKek("")).toThrow(/required/);
    expect(() => loadCredentialKek(Buffer.alloc(16, 1).toString("base64"))).toThrow(/32 bytes/);
  });

  it("derives a distinct DEK per org from one KEK", () => {
    expect(deriveOrgCredentialDek(KEK, ORG_A).equals(deriveOrgCredentialDek(KEK, ORG_B))).toBe(
      false,
    );
    // Deterministic: the same org always derives the same key (no per-tenant key table in Phase 1).
    expect(deriveOrgCredentialDek(KEK, ORG_A).equals(deriveOrgCredentialDek(KEK, ORG_A))).toBe(
      true,
    );
  });

  it("exposes an org-scoped port that seals and opens without leaking the DEK", () => {
    const port = buildCredentialCipherPort(loadCredentialKek(KEK_B64));
    const cipher = port.seal(ORG_A, SECRET);
    expect(port.open(ORG_A, cipher)).toBe(SECRET);
    expect(() => port.open(ORG_B, cipher)).toThrow();
  });
});
