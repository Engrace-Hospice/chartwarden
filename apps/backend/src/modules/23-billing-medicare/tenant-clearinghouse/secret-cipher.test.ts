import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildClearinghouseSecretCipher,
  platformCredentialFingerprints,
  retiredFingerprintKeks,
} from "./secret-cipher";

describe("the platform's own account fingerprints", () => {
  it("covers each platform vendor key that is set, and nothing else", () => {
    const cipher = buildClearinghouseSecretCipher(randomBytes(32));
    const set = platformCredentialFingerprints(cipher, {
      CLAIMMD_ACCOUNT_KEY: " fake-platform-claimmd#1 ",
      STEDI_API_KEY: "",
    });
    expect([...set]).toEqual([cipher.fingerprint("claimmd", "fake-platform-claimmd#1")]);
    expect(platformCredentialFingerprints(cipher, {}).size).toBe(0);
  });
});

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const KEY = "fake-claimmd-key#with*specials";

describe("clearinghouse secret cipher", () => {
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  const ctx = { vendor: "claimmd", mode: "test" } as const;

  it("round-trips a secret that contains # and *", async () => {
    const sealed = await cipher.encrypt(ORG_A, KEY, ctx);
    expect(sealed.cipher).not.toContain(KEY);
    expect(await cipher.decrypt(ORG_A, ctx, sealed.cipher)).toBe(KEY);
  });

  it("will not open for another tenant, another vendor or the other mode", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG_A, KEY, ctx);
    await expect(cipher.decrypt(ORG_B, ctx, sealed)).rejects.toThrow(/did not open/);
    await expect(cipher.decrypt(ORG_A, { ...ctx, vendor: "stedi" }, sealed)).rejects.toThrow(
      /did not open/,
    );
    await expect(cipher.decrypt(ORG_A, { ...ctx, mode: "production" }, sealed)).rejects.toThrow(
      /did not open/,
    );
  });

  it("will not open under another key, or a tampered or truncated envelope", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG_A, KEY, ctx);
    const other = buildClearinghouseSecretCipher(randomBytes(32));
    await expect(other.decrypt(ORG_A, ctx, sealed)).rejects.toThrow(/did not open/);
    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await expect(cipher.decrypt(ORG_A, ctx, bytes.toString("base64"))).rejects.toThrow(
      /did not open/,
    );
    await expect(cipher.decrypt(ORG_A, ctx, "AA==")).rejects.toThrow(/did not open/);
  });

  it("seals the same secret differently each time", async () => {
    const a = await cipher.encrypt(ORG_A, KEY, ctx);
    const b = await cipher.encrypt(ORG_A, KEY, ctx);
    expect(a.cipher).not.toBe(b.cipher);
  });

  // One vendor account belongs to one tenant (migration 1403): the fingerprint is the same for the same account whoever seals it,
  // differs per vendor, ignores surrounding whitespace, is keyed (another KEK gives another value) and never contains the key.
  it("fingerprints an account key: stable across orgs and modes, per vendor, keyed, and never the key itself", () => {
    const fp = cipher.fingerprint("claimmd", KEY);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain(KEY);
    expect(cipher.fingerprint("claimmd", `  ${KEY} `)).toBe(fp);
    expect(cipher.fingerprint("stedi", KEY)).not.toBe(fp);
    expect(cipher.fingerprint("claimmd", `${KEY}x`)).not.toBe(fp);
    expect(buildClearinghouseSecretCipher(randomBytes(32)).fingerprint("claimmd", KEY)).not.toBe(
      fp,
    );
  });

  // Known answer (security review LOW-8): the fingerprint key is HKDF(KEK) under its OWN label, not the DEK's or the AAD's, so a
  // fingerprint is never an HMAC under a key that also seals a credential. Recomputed here with node:crypto from the spec.
  it("derives the fingerprint key under its own label (known answer), distinct from the DEK and AAD derivations", () => {
    const kek = Buffer.alloc(32, 7);
    const hmacUnder = (info: string) =>
      createHmac("sha256", Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), info, 32)))
        .update(`claimmd\n${KEY}`, "utf8")
        .digest("hex");
    const fp = buildClearinghouseSecretCipher(kek).fingerprint("claimmd", KEY);
    expect(fp).toBe(hmacUnder("chartwarden-m23-clearinghouse-credential-fingerprint:v1"));
    expect(fp).not.toBe(hmacUnder(`chartwarden-m23-clearinghouse-credential-dek:${ORG_A}`));
    expect(fp).not.toBe(hmacUnder("chartwarden-m23-clearinghouse-credential:v1"));
    expect(fp).not.toBe(createHmac("sha256", kek).update(`claimmd\n${KEY}`, "utf8").digest("hex"));
  });

  // Migration 1405 (security review MEDIUM-1): a retired KEK only fingerprints. A credential is fingerprinted under the current key
  // first, then each retired one, each with its key's public id; the old cipher's fingerprint is among them, so a reservation it
  // recorded still collides on the unique index.
  it("fingerprints under the current key and each retired KEK, with a stable public key id", () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const before = buildClearinghouseSecretCipher(oldKek);
    const after = buildClearinghouseSecretCipher(newKek, [oldKek, newKek]);
    const all = after.fingerprints("claimmd", KEY);
    expect(all).toEqual([
      { keyId: after.fingerprintKeyId, fingerprint: after.fingerprint("claimmd", KEY) },
      { keyId: before.fingerprintKeyId, fingerprint: before.fingerprint("claimmd", KEY) },
    ]); // a retired entry equal to the current KEK is dropped
    expect(after.fingerprintKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(after.fingerprintKeyId).not.toBe(before.fingerprintKeyId);
    expect(buildClearinghouseSecretCipher(newKek).fingerprintKeyId).toBe(after.fingerprintKeyId);
    expect(platformCredentialFingerprints(after, { CLAIMMD_ACCOUNT_KEY: KEY }).size).toBe(2);
  });

  it("reads the retired KEKs fail-closed", () => {
    const a = Buffer.alloc(32, 1).toString("base64");
    const b = Buffer.alloc(32, 2).toString("base64");
    const env = (v: string) => ({ M23_CLEARINGHOUSE_FINGERPRINT_RETIRED_KEKS: v });
    expect(retiredFingerprintKeks({})).toEqual([]);
    expect(retiredFingerprintKeks(env(` ${a} , ${b}`)).map((k) => k.toString("base64"))).toEqual([
      a,
      b,
    ]);
    expect(() => retiredFingerprintKeks(env(`${a},short`))).toThrow(/32 bytes/);
  });

  it("rejects a KEK that is not 32 bytes", () => {
    expect(() => buildClearinghouseSecretCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
