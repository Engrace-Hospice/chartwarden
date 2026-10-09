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
const SECRET = "mac-portal-client-secret-ÿ-ü";
const newKek = () => randomBytes(32);

describe("M23 MAC secret cipher", () => {
  it("round-trips a secret under the same key and org, stamping the key version", async () => {
    const c = buildMacSecretCipher(newKek());
    const { cipher, dekVersion } = await c.encrypt(ORG_A, SECRET);
    expect(dekVersion).toBe(MAC_SECRET_CIPHER_VERSION);
    expect(await c.decrypt(ORG_A, cipher)).toBe(SECRET);
  });

  it("never stores plaintext and uses a fresh nonce per call", async () => {
    const c = buildMacSecretCipher(newKek());
    const a = (await c.encrypt(ORG_A, SECRET)).cipher;
    const b = (await c.encrypt(ORG_A, SECRET)).cipher;
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64").toString("utf8")).not.toContain(SECRET);
    expect(a).not.toContain(SECRET);
  });

  it("rejects a tampered ciphertext (any byte flipped in nonce, body or tag)", async () => {
    const c = buildMacSecretCipher(newKek());
    const raw = Buffer.from((await c.encrypt(ORG_A, SECRET)).cipher, "base64");
    for (const index of [1, 14, raw.length - 1]) {
      const copy = Buffer.from(raw);
      copy[index] = (copy[index] ?? 0) ^ 0xff;
      await expect(c.decrypt(ORG_A, copy.toString("base64"))).rejects.toThrow(
        /failed authentication/,
      );
    }
  });

  it("rejects the wrong key", async () => {
    const sealed = (await buildMacSecretCipher(newKek()).encrypt(ORG_A, SECRET)).cipher;
    await expect(buildMacSecretCipher(newKek()).decrypt(ORG_A, sealed)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects another tenant's org (DEK and AAD are org-bound)", async () => {
    const c = buildMacSecretCipher(newKek());
    const sealed = (await c.encrypt(ORG_A, SECRET)).cipher;
    await expect(c.decrypt(ORG_B, sealed)).rejects.toThrow(/failed authentication/);
  });

  it("rejects malformed, truncated, unsupported-version and shred-marker envelopes without echoing them", async () => {
    const c = buildMacSecretCipher(newKek());
    const sealed = Buffer.from((await c.encrypt(ORG_A, SECRET)).cipher, "base64");
    const wrongVersion = Buffer.from(sealed);
    wrongVersion[0] = 9;
    await expect(c.decrypt(ORG_A, wrongVersion.toString("base64"))).rejects.toThrow(
      /unsupported version/,
    );
    await expect(c.decrypt(ORG_A, "AAAA")).rejects.toThrow(/malformed/);
    await expect(c.decrypt(ORG_A, "SHREDDED")).rejects.toThrow(/malformed|failed/);
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
    const m24 = Buffer.concat([Buffer.from([1]), nonce, ct, cph.getAuthTag()]).toString("base64");
    await expect(buildMacSecretCipher(kek).decrypt(ORG_A, m24)).rejects.toThrow(
      /failed authentication/,
    );
  });
});
