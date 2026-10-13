// `POST /provider-entities` answered 503 TAX_ID_CIPHER_UNBOUND in every environment, so no tenant could register its CMS
// identity. The cipher seals the EIN under the tenant's own DEK from M34's key ring (the M20/M18 precedent): AES-256-GCM,
// the DEK version travels in the envelope so a rotation leaves old rows openable, and the AAD binds the blob to this
// purpose AND tenant so a blob lifted into another tenant (or another column) refuses to open.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type TaxIdKeyProvider, createTaxIdCipher } from "../src/modules/02-identity/tax-id-cipher";

const EIN = "12-3456789";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PE_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PE_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** A key ring that can rotate: `current` is what new data seals under, every version stays openable. */
function keyRing(): TaxIdKeyProvider & { rotate(): void } {
  const versions = new Map<string, Buffer>([["v1", randomBytes(32)]]);
  let current = "v1";
  return {
    rotate() {
      current = `v${versions.size + 1}`;
      versions.set(current, randomBytes(32));
    },
    async dekForOrg() {
      return { version: current, key: versions.get(current) as Buffer };
    },
    async dekForOrgVersion(_org, version) {
      const key = versions.get(version);
      if (!key) throw new Error(`no such DEK version ${version}`);
      return { version, key };
    },
  };
}

describe("createTaxIdCipher", () => {
  it("round-trips the EIN and never stores it in the clear", async () => {
    const cipher = createTaxIdCipher(keyRing());

    const sealed = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    expect(sealed).not.toContain("3456789");
    expect(await cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed })).toBe(
      EIN,
    );
  });

  it("uses a fresh nonce every time, so equal EINs do not produce equal ciphertext", async () => {
    const cipher = createTaxIdCipher(keyRing());

    const a = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });
    const b = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    expect(a).not.toBe(b);
  });

  it("refuses to open a blob under another tenant (AAD binds the tenant)", async () => {
    const ring = keyRing();
    const cipher = createTaxIdCipher(ring);
    const sealed = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    await expect(
      cipher.decrypt({ organizationId: ORG_B, providerEntityId: PE_1, sealed }),
    ).rejects.toThrow();
  });

  it("refuses to open a blob under another provider entity of the same tenant (AAD binds the row)", async () => {
    const cipher = createTaxIdCipher(keyRing());
    const sealed = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    await expect(
      cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_2, sealed }),
    ).rejects.toThrow();
  });

  it("rejects a pre-row-binding v1 envelope as malformed", async () => {
    const cipher = createTaxIdCipher(keyRing());
    const sealed = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    await expect(
      cipher.decrypt({
        organizationId: ORG_A,
        providerEntityId: PE_1,
        sealed: sealed.replace(/^v2\./, "v1."),
      }),
    ).rejects.toThrow(/malformed/);
  });

  it("still opens old rows after the key ring rotates, because the DEK version is in the envelope", async () => {
    const ring = keyRing();
    const cipher = createTaxIdCipher(ring);
    const before = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    ring.rotate();
    const after = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });

    expect(before.split(".")[1]).toBe("v1");
    expect(after.split(".")[1]).toBe("v2");
    expect(
      await cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed: before }),
    ).toBe(EIN);
    expect(
      await cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed: after }),
    ).toBe(EIN);
  });

  it("rejects a tampered ciphertext or a truncated tag", async () => {
    const cipher = createTaxIdCipher(keyRing());
    const sealed = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: EIN,
    });
    const [scheme, version, nonce, tag, ciphertext] = sealed.split(".");

    const flipped = [scheme, version, nonce, tag, `${ciphertext?.slice(0, -2)}AA`].join(".");
    const shortTag = [scheme, version, nonce, tag?.slice(0, 6), ciphertext].join(".");

    await expect(
      cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed: flipped }),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed: shortTag }),
    ).rejects.toThrow();
  });

  it("refuses a malformed envelope", async () => {
    const cipher = createTaxIdCipher(keyRing());

    await expect(
      cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed: "not-an-envelope" }),
    ).rejects.toThrow(/malformed/);
  });

  it("refuses an envelope with extra segments or a wrong-length nonce", async () => {
    const keys = keyRing();
    const cipher = createTaxIdCipher(keys);
    const sealed = await cipher.encrypt({
      organizationId: ORG_A,
      providerEntityId: PE_1,
      plaintext: "12-3456789",
    });
    const [scheme, version, nonce, tag, ciphertext] = sealed.split(".");

    await expect(
      cipher.decrypt({ organizationId: ORG_A, providerEntityId: PE_1, sealed: `${sealed}.extra` }),
    ).rejects.toThrow(/malformed/);
    await expect(
      cipher.decrypt({
        organizationId: ORG_A,
        providerEntityId: PE_1,
        sealed: [scheme, version, nonce?.slice(0, 6), tag, ciphertext].join("."),
      }),
    ).rejects.toThrow(/malformed/);
  });

  it("fails closed when the key ring hands back a key that is not 256 bits", async () => {
    const cipher = createTaxIdCipher({
      dekForOrg: async () => ({ version: "v1", key: Buffer.alloc(16) }),
      dekForOrgVersion: async () => ({ version: "v1", key: Buffer.alloc(16) }),
    });

    await expect(
      cipher.encrypt({ organizationId: ORG_A, providerEntityId: PE_1, plaintext: EIN }),
    ).rejects.toThrow(/32 bytes/);
  });

  it("fails closed when the key ring is unbound (no platform KEK), never falling back to plaintext", async () => {
    const cipher = createTaxIdCipher({
      dekForOrg: async () => {
        throw new Error("tenant key provider is unbound");
      },
      dekForOrgVersion: async () => {
        throw new Error("tenant key provider is unbound");
      },
    });

    await expect(
      cipher.encrypt({ organizationId: ORG_A, providerEntityId: PE_1, plaintext: EIN }),
    ).rejects.toThrow(/unbound/);
  });
});
