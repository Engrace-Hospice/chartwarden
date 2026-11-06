// Slice 4 — the sealed clinic credential: AES-256-GCM under the tenant's key-ring DEK, the envelope bound to the row it was
// sealed for. Pure: a fake key ring, no database.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ClinicSecretBundle,
  type ClinicSecretContext,
  buildClinicSecretCipher,
} from "./secret-cipher";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CTX: ClinicSecretContext = { environment: "sandbox", clinicId: "clinic-1" };
const BUNDLE: ClinicSecretBundle = {
  clinicKey: "clinic-key-plaintext-9f3a",
  subscriptionKey: "sub-key-plaintext-77",
};

function ring() {
  const keys = new Map<string, Buffer>([["v1", randomBytes(32)]]);
  let active = "v1";
  return {
    rotate(version: string) {
      keys.set(version, randomBytes(32));
      active = version;
    },
    provider: {
      dekForOrg: async () => ({ version: active, key: keys.get(active) as Buffer }),
      dekForOrgVersion: async (_org: string, version: string) => {
        const key = keys.get(version);
        if (!key) throw new Error("no such DEK version");
        return { version, key };
      },
    },
  };
}

describe("clinic secret cipher", () => {
  it("round-trips the whole bundle and records the DEK version it sealed with", async () => {
    const cipher = buildClinicSecretCipher(ring().provider);
    const sealed = await cipher.encrypt(ORG, BUNDLE, CTX);
    expect(sealed.dekRef).toBe("v1");
    expect(sealed.cipher).not.toContain("clinic-key-plaintext");
    expect(await cipher.decrypt(ORG, CTX, sealed.cipher, sealed.dekRef)).toEqual(BUNDLE);
  });

  it("seals a bundle with no Subscription-Key and gives it back without one", async () => {
    const cipher = buildClinicSecretCipher(ring().provider);
    const sealed = await cipher.encrypt(ORG, { clinicKey: "only-the-clinic-key" }, CTX);
    expect(await cipher.decrypt(ORG, CTX, sealed.cipher, sealed.dekRef)).toEqual({
      clinicKey: "only-the-clinic-key",
    });
  });

  it("a fresh nonce every time: the same bundle never seals to the same text", async () => {
    const cipher = buildClinicSecretCipher(ring().provider);
    const a = await cipher.encrypt(ORG, BUNDLE, CTX);
    const b = await cipher.encrypt(ORG, BUNDLE, CTX);
    expect(a.cipher).not.toBe(b.cipher);
  });

  it("is bound to its organization, environment and clinic: a copy elsewhere does not open", async () => {
    const r = ring();
    const cipher = buildClinicSecretCipher(r.provider); // ONE key for every org: only the AAD can refuse
    const sealed = await cipher.encrypt(ORG, BUNDLE, CTX);
    const refusals = [
      cipher.decrypt(OTHER, CTX, sealed.cipher, sealed.dekRef),
      cipher.decrypt(ORG, { ...CTX, environment: "production" }, sealed.cipher, sealed.dekRef),
      cipher.decrypt(ORG, { ...CTX, clinicId: "clinic-2" }, sealed.cipher, sealed.dekRef),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toThrow("clinic secret cipher: ciphertext did not open");
    }
  });

  it("opens an old envelope after the key ring rotated, by the DEK version it names", async () => {
    const r = ring();
    const cipher = buildClinicSecretCipher(r.provider);
    const old = await cipher.encrypt(ORG, BUNDLE, CTX);
    r.rotate("v2");
    const fresh = await cipher.encrypt(ORG, BUNDLE, CTX);
    expect(fresh.dekRef).toBe("v2");
    expect(await cipher.decrypt(ORG, CTX, old.cipher, old.dekRef)).toEqual(BUNDLE);
  });

  it("refuses a tampered, truncated or foreign envelope with ONE generic error and no plaintext", async () => {
    const cipher = buildClinicSecretCipher(ring().provider);
    const sealed = await cipher.encrypt(ORG, BUNDLE, CTX);
    const parts = sealed.cipher.split(".");
    const flipped = [parts[0], parts[1], parts[2], `${(parts[3] as string).slice(0, -2)}AA`].join(
      ".",
    );
    for (const bad of [flipped, "v1.a.b", "garbage", "v9.x.y.z", ""]) {
      const err = await cipher.decrypt(ORG, CTX, bad, "v1").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("clinic secret cipher: ciphertext did not open");
      expect((err as Error).message).not.toContain("plaintext");
    }
  });

  it("refuses an envelope whose GCM tag is not the full 16 bytes (a truncated tag is a forgery surface)", async () => {
    const cipher = buildClinicSecretCipher(ring().provider);
    const sealed = await cipher.encrypt(ORG, BUNDLE, CTX);
    const [v, nonce, tag, ct] = sealed.cipher.split(".");
    const truncated = [
      v,
      nonce,
      Buffer.from(tag as string, "base64url")
        .subarray(0, 4)
        .toString("base64url"),
      ct,
    ].join(".");
    await expect(cipher.decrypt(ORG, CTX, truncated, sealed.dekRef)).rejects.toThrow(
      "clinic secret cipher: ciphertext did not open",
    );
  });

  it("an unknown DEK version is the same generic refusal, not a leak of the key ring's error", async () => {
    const cipher = buildClinicSecretCipher(ring().provider);
    const sealed = await cipher.encrypt(ORG, BUNDLE, CTX);
    await expect(cipher.decrypt(ORG, CTX, sealed.cipher, "v404")).rejects.toThrow(
      "clinic secret cipher: ciphertext did not open",
    );
  });

  it("refuses a key that is not 32 bytes", async () => {
    const cipher = buildClinicSecretCipher({
      dekForOrg: async () => ({ version: "v1", key: randomBytes(16) }),
    });
    await expect(cipher.encrypt(ORG, BUNDLE, CTX)).rejects.toThrow("32 bytes");
  });
});
