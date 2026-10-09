import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAC_SECRET_CIPHER_VERSION,
  buildMacSecretCipher,
  buildMacSecretCipherFromEnv,
  loadMacSecretKek,
} from "../routes/secret-cipher";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PE = "33333333-3333-4333-8333-333333333333";
const PE2 = "44444444-4444-4444-8444-444444444444";
const CTX = { providerEntityId: PE, macJurisdiction: "cgs_j15" };
const SECRET = "mac-portal-client-secret-ÿ-ü";
const newKek = () => randomBytes(32);

describe("M23 MAC secret cipher", () => {
  it("round-trips a secret under the same key and org, stamping the key version", async () => {
    const c = buildMacSecretCipher(newKek());
    const { cipher, dekVersion } = await c.encrypt(ORG_A, SECRET, CTX);
    expect(dekVersion).toBe(MAC_SECRET_CIPHER_VERSION);
    expect(await c.decrypt(ORG_A, CTX, cipher)).toBe(SECRET);
  });

  it("never stores plaintext and uses a fresh nonce per call", async () => {
    const c = buildMacSecretCipher(newKek());
    const a = (await c.encrypt(ORG_A, SECRET, CTX)).cipher;
    const b = (await c.encrypt(ORG_A, SECRET, CTX)).cipher;
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64").toString("utf8")).not.toContain(SECRET);
    expect(a).not.toContain(SECRET);
  });

  it("rejects a tampered ciphertext (any byte flipped in nonce, body or tag)", async () => {
    const c = buildMacSecretCipher(newKek());
    const raw = Buffer.from((await c.encrypt(ORG_A, SECRET, CTX)).cipher, "base64");
    for (const index of [1, 14, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] = (copy[index] ?? 0) ^ 0xff;
      await expect(c.decrypt(ORG_A, CTX, copy.toString("base64"))).rejects.toThrow(
        /failed authentication/,
      );
    }
  });

  it("rejects a ciphertext moved to another provider entity or MAC jurisdiction of the same org", async () => {
    const c = buildMacSecretCipher(newKek());
    const sealed = (await c.encrypt(ORG_A, SECRET, CTX)).cipher;
    await expect(c.decrypt(ORG_A, { ...CTX, providerEntityId: PE2 }, sealed)).rejects.toThrow(
      /failed authentication/,
    );
    await expect(c.decrypt(ORG_A, { ...CTX, macJurisdiction: "ngs_j6" }, sealed)).rejects.toThrow(
      /failed authentication/,
    );
    expect(await c.decrypt(ORG_A, CTX, sealed)).toBe(SECRET);
  });

  it("authenticates the version byte: it is in the AAD, and only the current version is accepted", async () => {
    const c = buildMacSecretCipher(newKek());
    const raw = Buffer.from((await c.encrypt(ORG_A, SECRET, CTX)).cipher, "base64");
    expect(raw[0]).toBe(MAC_SECRET_CIPHER_VERSION);
    expect(MAC_SECRET_CIPHER_VERSION).toBe(2);
    const v1 = Buffer.from(raw);
    v1[0] = 1;
    await expect(c.decrypt(ORG_A, CTX, v1.toString("base64"))).rejects.toThrow(
      /unsupported version/,
    );
  });

  it("rejects the wrong key", async () => {
    const sealed = (await buildMacSecretCipher(newKek()).encrypt(ORG_A, SECRET, CTX)).cipher;
    await expect(buildMacSecretCipher(newKek()).decrypt(ORG_A, CTX, sealed)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects another tenant's org (DEK and AAD are org-bound)", async () => {
    const c = buildMacSecretCipher(newKek());
    const sealed = (await c.encrypt(ORG_A, SECRET, CTX)).cipher;
    await expect(c.decrypt(ORG_B, CTX, sealed)).rejects.toThrow(/failed authentication/);
  });

  it("rejects malformed, truncated, unsupported-version and shred-marker envelopes without echoing them", async () => {
    const c = buildMacSecretCipher(newKek());
    const sealed = Buffer.from((await c.encrypt(ORG_A, SECRET, CTX)).cipher, "base64");
    const wrongVersion = Buffer.from(sealed);
    wrongVersion[0] = 9;
    await expect(c.decrypt(ORG_A, CTX, wrongVersion.toString("base64"))).rejects.toThrow(
      /unsupported version/,
    );
    await expect(c.decrypt(ORG_A, CTX, "AAAA")).rejects.toThrow(/malformed/);
    await expect(c.decrypt(ORG_A, CTX, "SHREDDED")).rejects.toThrow(/malformed|failed/);
  });

  it("fails closed on a missing or wrong-length KEK", () => {
    expect(() => loadMacSecretKek(undefined)).toThrow(/required/);
    expect(() => loadMacSecretKek("  ")).toThrow(/required/);
    expect(() => loadMacSecretKek(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => buildMacSecretCipher(randomBytes(31))).toThrow(/32 bytes/);
  });

  it("binds from env only when the key is set; a malformed key refuses the boot", () => {
    expect(buildMacSecretCipherFromEnv({})).toBeUndefined();
    expect(
      buildMacSecretCipherFromEnv({ M24_CREDENTIAL_ENCRYPTION_KEY: newKek().toString("base64") }),
    ).toBeDefined();
    expect(() => buildMacSecretCipherFromEnv({ M24_CREDENTIAL_ENCRYPTION_KEY: "short" })).toThrow(
      /32 bytes/,
    );
  });

  it("is domain-separated from the M24 envelope under the same KEK", async () => {
    // An M24-style envelope (different HKDF label, no AAD) must not open as an M23 one.
    const { createCipheriv, hkdfSync, randomBytes: rb } = await import("node:crypto");
    const kek = newKek();
    const dek = Buffer.from(
      hkdfSync("sha256", kek, Buffer.alloc(0), `wardenx-m24-trading-partner-dek:${ORG_A}`, 32),
    );
    const nonce = rb(12);
    const cph = createCipheriv("aes-256-gcm", dek, nonce);
    const ct = Buffer.concat([cph.update(SECRET, "utf8"), cph.final()]);
    const m24 = Buffer.concat([
      Buffer.from([MAC_SECRET_CIPHER_VERSION]),
      nonce,
      ct,
      cph.getAuthTag(),
    ]).toString("base64");
    await expect(buildMacSecretCipher(kek).decrypt(ORG_A, CTX, m24)).rejects.toThrow(
      /failed authentication/,
    );
  });
});
