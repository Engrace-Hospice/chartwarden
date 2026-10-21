// GAP-010 — the M5 identifier envelope + SSN blind index (unit; no DB). The crypto properties the live suite
// re-proves against a real key ring: tenant/row/kind binding, tamper detection, rotation, fail-closed, no plaintext.
import { randomBytes } from "node:crypto";
import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  IdentifierCipherIntegrityError,
  IdentifierCipherUnboundError,
  type IdentifierKeyProvider,
  UNBOUND_IDENTIFIER_CIPHER,
  createPatientIdentifierCipher,
} from "../src/modules/05-patient/identifiers/identifier-cipher";
import {
  isStructurallyPossibleSsn,
  normalizeSsn,
  requireValidSsn,
} from "../src/modules/05-patient/identifiers/ssn";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const ROW = "11111111-1111-4111-8111-111111111111";
const OTHER_ROW = "22222222-2222-4222-8222-222222222222";
const SSN = "123456789";

/** A ring with one DEK per (org, version); `current` per org is mutable to model rotation. */
function ring(): {
  keys: IdentifierKeyProvider;
  rotate: (org: string, version: string) => void;
  destroy: (org: string) => void;
} {
  const deks = new Map<string, Buffer>();
  const current = new Map<string, string>();
  const destroyed = new Set<string>();
  const dek = (org: string, version: string): Buffer => {
    const k = `${org}/${version}`;
    if (!deks.has(k)) deks.set(k, randomBytes(32));
    return deks.get(k) as Buffer;
  };
  return {
    keys: {
      async dekForOrg(org) {
        if (destroyed.has(org)) throw new Error("TenantKeyDestroyed");
        const version = current.get(org) ?? "1";
        return { version, key: dek(org, version) };
      },
      async dekForOrgVersion(org, version) {
        if (destroyed.has(org)) throw new Error("TenantKeyDestroyed");
        return { version, key: dek(org, version) };
      },
    },
    rotate: (org, version) => void current.set(org, version),
    destroy: (org) => void destroyed.add(org),
  };
}

describe("identifier envelope", () => {
  it("round-trips and stamps the DEK version it sealed under", async () => {
    const cipher = createPatientIdentifierCipher(ring().keys);
    const sealed = await cipher.seal(ORG_A, ROW, "ssn", SSN);
    expect(sealed.dekVersion).toBe("1");
    expect(await cipher.open(ORG_A, ROW, "ssn", sealed.ciphertext)).toBe(SSN);
  });

  it("never contains the plaintext digits", async () => {
    const cipher = createPatientIdentifierCipher(ring().keys);
    const { ciphertext } = await cipher.seal(ORG_A, ROW, "ssn", SSN);
    expect(ciphertext.toString("latin1")).not.toContain(SSN);
    expect(ciphertext.toString("hex")).not.toContain(Buffer.from(SSN).toString("hex"));
  });

  it("does not open under another tenant, another row, or another kind", async () => {
    const { keys } = ring();
    const cipher = createPatientIdentifierCipher(keys);
    const { ciphertext } = await cipher.seal(ORG_A, ROW, "ssn", SSN);
    await expect(cipher.open(ORG_B, ROW, "ssn", ciphertext)).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
    await expect(cipher.open(ORG_A, OTHER_ROW, "ssn", ciphertext)).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
    await expect(cipher.open(ORG_A, ROW, "state_id", ciphertext)).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
  });

  it("rejects a tampered ciphertext, a tampered tag, and a truncated tag", async () => {
    const cipher = createPatientIdentifierCipher(ring().keys);
    const { ciphertext } = await cipher.seal(ORG_A, ROW, "ssn", SSN);
    const flipLast = Buffer.from(ciphertext);
    flipLast[flipLast.length - 1] = (flipLast[flipLast.length - 1] as number) ^ 0xff;
    await expect(cipher.open(ORG_A, ROW, "ssn", flipLast)).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
    const versionLength = ciphertext[1] as number;
    const tagStart = 2 + versionLength + 12;
    const flipTag = Buffer.from(ciphertext);
    flipTag[tagStart] = (flipTag[tagStart] as number) ^ 0x01;
    await expect(cipher.open(ORG_A, ROW, "ssn", flipTag)).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
    const truncated = Buffer.concat([
      ciphertext.subarray(0, tagStart + 4),
      ciphertext.subarray(tagStart + 16),
    ]);
    await expect(cipher.open(ORG_A, ROW, "ssn", truncated)).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
  });

  it("rejects the empty crypto-shred sentinel and unknown schemes", async () => {
    const cipher = createPatientIdentifierCipher(ring().keys);
    await expect(cipher.open(ORG_A, ROW, "ssn", Buffer.alloc(0))).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
    await expect(cipher.open(ORG_A, ROW, "ssn", Buffer.from([0x09, 1, 0x31]))).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
  });

  it("still opens a row sealed under a prior DEK version after rotation", async () => {
    const r = ring();
    const cipher = createPatientIdentifierCipher(r.keys);
    const before = await cipher.seal(ORG_A, ROW, "ssn", SSN);
    r.rotate(ORG_A, "2");
    const after = await cipher.seal(ORG_A, OTHER_ROW, "ssn", SSN);
    expect(before.dekVersion).toBe("1");
    expect(after.dekVersion).toBe("2");
    expect(await cipher.open(ORG_A, ROW, "ssn", before.ciphertext)).toBe(SSN);
    expect(await cipher.open(ORG_A, OTHER_ROW, "ssn", after.ciphertext)).toBe(SSN);
  });

  it("fails closed when the key ring is unbound or destroyed — no plaintext fallback", async () => {
    await expect(UNBOUND_IDENTIFIER_CIPHER.seal(ORG_A, ROW, "ssn", SSN)).rejects.toThrow(
      IdentifierCipherUnboundError,
    );
    const r = ring();
    const cipher = createPatientIdentifierCipher(r.keys);
    const sealed = await cipher.seal(ORG_A, ROW, "ssn", SSN);
    r.destroy(ORG_A);
    await expect(cipher.seal(ORG_A, ROW, "ssn", SSN)).rejects.toThrow(IdentifierCipherUnboundError);
    await expect(cipher.open(ORG_A, ROW, "ssn", sealed.ciphertext)).rejects.toThrow(
      IdentifierCipherUnboundError,
    );
    await expect(cipher.blindIndex(ORG_A, SSN)).rejects.toThrow(IdentifierCipherUnboundError);
  });

  it("an unbound error message carries no identifier value", async () => {
    const err = await UNBOUND_IDENTIFIER_CIPHER.seal(ORG_A, ROW, "ssn", SSN).catch(
      (e: unknown) => e as Error,
    );
    expect(String((err as Error).message)).not.toContain(SSN);
  });
});

describe("SSN blind index", () => {
  it("is deterministic and agrees for the same nine digits", async () => {
    const cipher = createPatientIdentifierCipher(ring().keys);
    const a = await cipher.blindIndex(ORG_A, SSN);
    const b = await cipher.blindIndex(ORG_A, normalizeSsn("123-45-6789") as string);
    expect(a.token.equals(b.token)).toBe(true);
    expect(a.token.byteLength).toBe(32);
    expect(a.token.toString("hex")).not.toContain(SSN);
  });

  it("differs per tenant, per DEK version, and per SSN", async () => {
    const r = ring();
    const cipher = createPatientIdentifierCipher(r.keys);
    const a = await cipher.blindIndex(ORG_A, SSN);
    expect((await cipher.blindIndex(ORG_B, SSN)).token.equals(a.token)).toBe(false);
    expect((await cipher.blindIndex(ORG_A, SSN, "2")).token.equals(a.token)).toBe(false);
    expect((await cipher.blindIndex(ORG_A, "123456780")).token.equals(a.token)).toBe(false);
  });

  it("probes every version still on file", async () => {
    const r = ring();
    const cipher = createPatientIdentifierCipher(r.keys);
    const v1 = await cipher.blindIndex(ORG_A, SSN);
    r.rotate(ORG_A, "2");
    const v2 = await cipher.blindIndex(ORG_A, SSN);
    const map = await cipher.blindIndexesForVersions(ORG_A, SSN, ["1", "2", "2"]);
    expect([...map.keys()].sort()).toEqual(["1", "2"]);
    // each version maps to [current-label token, legacy-label token]; the writer (legacy) token is among them
    expect(map.get("1")?.some((t) => t.equals(v1.token))).toBe(true);
    expect(map.get("2")?.some((t) => t.equals(v2.token))).toBe(true);
  });
});

describe("SSN normalization and validation", () => {
  it("normalizes dashed and plain forms to the same nine digits", () => {
    expect(normalizeSsn("123-45-6789")).toBe("123456789");
    expect(normalizeSsn("123 45 6789")).toBe("123456789");
    expect(normalizeSsn("12345678")).toBeNull();
    expect(normalizeSsn("1234567890")).toBeNull();
    expect(normalizeSsn(null)).toBeNull();
  });

  it("rejects only structurally impossible values and accepts 9xx (ITIN)", () => {
    expect(isStructurallyPossibleSsn("000451234")).toBe(false);
    expect(isStructurallyPossibleSsn("666451234")).toBe(false);
    expect(isStructurallyPossibleSsn("123001234")).toBe(false);
    expect(isStructurallyPossibleSsn("123450000")).toBe(false);
    expect(isStructurallyPossibleSsn("123456789")).toBe(true);
    expect(isStructurallyPossibleSsn("912701234")).toBe(true);
  });

  it("a rejection never echoes the input", () => {
    for (const bad of ["000-45-6789", "12-34", "abc12345xyz"]) {
      let caught: unknown;
      try {
        requireValidSsn(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      const serialised = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
      expect(serialised).not.toContain("000-45-6789");
      expect(serialised).not.toContain("12345");
      expect(serialised).not.toContain("abc123");
      expect((caught as ValidationError).message).not.toMatch(/\d{3}/);
    }
  });
});
