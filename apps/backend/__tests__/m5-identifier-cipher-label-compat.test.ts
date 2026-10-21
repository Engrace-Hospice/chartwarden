// ChartWarden rename, release 1 (read-side): the M5 identifier envelope AAD and the SSN blind-index label are read under
// BOTH the legacy "wardenx:" and the new "chartwarden:" label. Fixtures are built here with literal strings (an oracle
// independent of the module's constants) to stand for what production holds / what the future writer flip will emit.
// LEGACY(wardenx->chartwarden): delete the legacy cases after the backfill.
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IdentifierCipherIntegrityError,
  type IdentifierKeyProvider,
  createPatientIdentifierCipher,
} from "../src/modules/05-patient/identifiers/identifier-cipher";

const ORG = "00000000-0000-4000-8000-00000000000a";
const ROW = "11111111-1111-4111-8111-111111111111";
const OTHER_ROW = "22222222-2222-4222-8222-222222222222";
const SSN = "123456789";
const DEK = randomBytes(32);
const keys: IdentifierKeyProvider = {
  dekForOrg: async () => ({ version: "1", key: DEK }),
  dekForOrgVersion: async (_org, version) => ({ version, key: DEK }),
};

const aad = (prefix: string) =>
  `${prefix}:m5:patient_identifier:value_encrypted:v1:${ORG}:${ROW}:ssn`;
function envelope(prefix: string, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", DEK, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad(prefix), "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([1, 1]), Buffer.from("1"), nonce, c.getAuthTag(), ct]);
}
function token(prefix: string, ssn = SSN): Buffer {
  const k = Buffer.from(
    hkdfSync(
      "sha256",
      DEK,
      Buffer.alloc(0),
      Buffer.from(`${prefix}:m5:ssn-blind-index:v1:${ORG}`),
      32,
    ),
  );
  return createHmac("sha256", k).update(`ssn:${ssn}`, "utf8").digest();
}

describe("identifier envelope labels", () => {
  const cipher = createPatientIdentifierCipher(keys);

  it("opens an envelope written under the legacy wardenx label (what production holds)", async () => {
    expect(await cipher.open(ORG, ROW, "ssn", envelope("wardenx", SSN))).toBe(SSN);
  });

  it("opens an envelope written under the new chartwarden label (the future writer flip)", async () => {
    expect(await cipher.open(ORG, ROW, "ssn", envelope("chartwarden", SSN))).toBe(SSN);
  });

  it("still seals under the legacy label in this release", async () => {
    const sealed = (await cipher.seal(ORG, ROW, "ssn", SSN)).ciphertext;
    const nonce = sealed.subarray(3, 3 + 12);
    const tag = sealed.subarray(3 + 12, 3 + 12 + 16);
    const c = createCipheriv("aes-256-gcm", DEK, nonce, { authTagLength: 16 });
    c.setAAD(Buffer.from(aad("wardenx"), "utf8"));
    c.update(SSN, "utf8");
    c.final();
    expect(c.getAuthTag().equals(tag)).toBe(true);
  });

  it("fails closed under any other label, with a generic error that names no label", async () => {
    await expect(cipher.open(ORG, ROW, "ssn", envelope("somethingelse", SSN))).rejects.toThrow(
      IdentifierCipherIntegrityError,
    );
    const tampered = Buffer.from(envelope("wardenx", SSN));
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
    const err = await cipher.open(ORG, ROW, "ssn", tampered).catch((e: Error) => e);
    expect(err).toBeInstanceOf(IdentifierCipherIntegrityError);
    expect((err as Error).message).not.toMatch(/wardenx|chartwarden|label/i);
  });

  it("does not open another row's envelope under either label", async () => {
    for (const prefix of ["wardenx", "chartwarden"]) {
      await expect(cipher.open(ORG, OTHER_ROW, "ssn", envelope(prefix, SSN))).rejects.toThrow(
        IdentifierCipherIntegrityError,
      );
    }
  });
});

describe("SSN blind-index labels", () => {
  const cipher = createPatientIdentifierCipher(keys);

  it("writes the legacy-label token in this release", async () => {
    expect((await cipher.blindIndex(ORG, SSN)).token.equals(token("wardenx"))).toBe(true);
  });

  it("the dual probe contains both the legacy and the new token, so either stored row is found", async () => {
    const probe = (await cipher.blindIndexesForVersions(ORG, SSN, ["1"])).get("1") ?? [];
    expect(probe.some((t) => t.equals(token("wardenx")))).toBe(true);
    expect(probe.some((t) => t.equals(token("chartwarden")))).toBe(true);
  });

  it("never probes a token that belongs to a different SSN (no false duplicates)", async () => {
    const probe = (await cipher.blindIndexesForVersions(ORG, SSN, ["1"])).get("1") ?? [];
    expect(probe.some((t) => t.equals(token("wardenx", "123456780")))).toBe(false);
    expect(probe.some((t) => t.equals(token("chartwarden", "123456780")))).toBe(false);
  });
});
