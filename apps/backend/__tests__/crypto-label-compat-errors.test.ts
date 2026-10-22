// ChartWarden rename, release 3: a ciphertext sealed under an UNKNOWN label ("otherapp") and one sealed under the REMOVED legacy
// label ("wardenx") must each fail with the same error type and message as a tampered one in every module, so a refusal is no
// oracle for "which label is this". Fixtures use literal label strings (independent of the modules' constants).
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { deriveOrgDek, openMessageBody, openMessageBodyRing } from "@chartwarden/messaging";
import { PseudonymKekError, openPseudonymKeyMaterial } from "@chartwarden/subscription-billing";
import { describe, expect, it } from "vitest";
import { PlatformKekError, createPlatformKekAdapter } from "../src/bootstrap/tenant-kek";
import {
  IdentifierCipherIntegrityError,
  type IdentifierKeyProvider,
  createPatientIdentifierCipher,
} from "../src/modules/05-patient/identifiers/identifier-cipher";
import { buildMacSecretCipher } from "../src/modules/23-billing-medicare/routes/secret-cipher";
import { buildCredentialCipherPort } from "../src/modules/24-billing-medicaid/credential-crypto";

const ORG = "00000000-0000-4000-8000-00000000000a";
const KEK = randomBytes(32);
const hkdf = (ikm: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));

function gcm(key: Buffer, plaintext: Buffer, aad?: string) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  if (aad !== undefined) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { nonce, ct, tag: c.getAuthTag() };
}
const flip = (b: Buffer): Buffer => {
  const out = Buffer.from(b);
  out[out.length - 1] = (out[out.length - 1] as number) ^ 0xff;
  return out;
};
const b64 = (b: Buffer): string => b.toString("base64");
const errorOf = async (run: () => unknown): Promise<Error> => {
  try {
    await run();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};
const sameFailure = (a: Error, b: Error) => {
  expect(a.constructor).toBe(b.constructor);
  expect(a.message).toBe(b.message);
};

describe("unknown and legacy labels fail exactly like a tampered ciphertext", () => {
  it("M36 v1 body", async () => {
    const mk = (prefix: string) => {
      const { nonce, ct, tag } = gcm(hkdf(KEK, `${prefix}-message-dek:${ORG}`), Buffer.from("x"));
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    };
    const dek = deriveOrgDek(KEK, ORG);
    const wrong = await errorOf(() => openMessageBody(mk("otherapp"), dek));
    const tampered = await errorOf(() => openMessageBody(flip(mk("chartwarden")), dek));
    const legacy = await errorOf(() => openMessageBody(mk("wardenx"), dek));
    // positive control: the same fixture layout with the real label opens
    expect(openMessageBody(mk("chartwarden"), dek)).toBe("x");
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
  });

  it("M36 ring AAD", async () => {
    const key = randomBytes(32);
    const mk = (prefix: string) => {
      const { nonce, ct, tag } = gcm(key, Buffer.from("x"), `${prefix}-message-body:v2:${ORG}:v1`);
      return Buffer.concat([Buffer.from([2, 2]), Buffer.from("v1"), nonce, ct, tag]);
    };
    const wrong = await errorOf(() => openMessageBodyRing(mk("otherapp"), key, ORG));
    const tampered = await errorOf(() => openMessageBodyRing(flip(mk("chartwarden")), key, ORG));
    const legacy = await errorOf(() => openMessageBodyRing(mk("wardenx"), key, ORG));
    expect(openMessageBodyRing(mk("chartwarden"), key, ORG)).toBe("x");
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
  });

  it("M24", async () => {
    const port = buildCredentialCipherPort(KEK);
    const mk = (prefix: string) => {
      const dek = hkdf(KEK, `${prefix}-m24-trading-partner-dek:${ORG}`);
      const { nonce, ct, tag } = gcm(dek, Buffer.from("x"));
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    };
    const wrong = await errorOf(() => port.open(ORG, b64(mk("otherapp"))));
    const tampered = await errorOf(() => port.open(ORG, b64(flip(mk("chartwarden")))));
    const legacy = await errorOf(() => port.open(ORG, b64(mk("wardenx"))));
    expect(port.open(ORG, b64(mk("chartwarden")))).toBe("x");
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
  });

  it("M35", async () => {
    const ring = { active: { kekId: "k", key: KEK }, byId: new Map([["k", KEK]]) };
    const mk = (prefix: string) => {
      const { nonce, ct, tag } = gcm(KEK, randomBytes(32), `${prefix}-m35-pseudonym-key:v1:k:e1`);
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    };
    const wrong = await errorOf(() =>
      openPseudonymKeyMaterial(ring, "k", "e1", b64(mk("otherapp"))),
    );
    const tampered = await errorOf(() =>
      openPseudonymKeyMaterial(ring, "k", "e1", b64(flip(mk("chartwarden")))),
    );
    const legacy = await errorOf(() =>
      openPseudonymKeyMaterial(ring, "k", "e1", b64(mk("wardenx"))),
    );
    expect(openPseudonymKeyMaterial(ring, "k", "e1", b64(mk("chartwarden"))).length).toBe(32);
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
    expect(wrong).toBeInstanceOf(PseudonymKekError);
  });

  it("M34", async () => {
    const adapter = createPlatformKekAdapter({
      active: { kekId: "k", key: KEK },
      byId: new Map([["k", KEK]]),
    });
    const mk = (prefix: string) => {
      const { nonce, ct, tag } = gcm(KEK, randomBytes(32), `${prefix}-m34-tenant-dek:v1:k:${ORG}`);
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    };
    const unwrap = (b: Buffer) =>
      adapter.unwrap({ organizationId: ORG, kekWrappedCiphertext: b, kekId: "k" });
    const wrong = await errorOf(() => unwrap(mk("otherapp")));
    const tampered = await errorOf(() => unwrap(flip(mk("chartwarden"))));
    const legacy = await errorOf(() => unwrap(mk("wardenx")));
    expect((await unwrap(mk("chartwarden"))).length).toBe(32);
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
    expect(wrong).toBeInstanceOf(PlatformKekError);
  });

  it("M23", async () => {
    const cipher = buildMacSecretCipher(KEK);
    const ctx = { providerEntityId: "aaaaaaaa-0000-4000-8000-000000000001", macJurisdiction: "JF" };
    const mk = (prefix: string) => {
      const dek = hkdf(KEK, `${prefix}-m23-mac-credential-dek:${ORG}`);
      const aad = [`${prefix}-m23-mac-credential:v2`, ORG, ctx.providerEntityId, "JF"].join("|");
      const { nonce, ct, tag } = gcm(dek, Buffer.from("x"), aad);
      return Buffer.concat([Buffer.from([2]), nonce, ct, tag]);
    };
    const wrong = await errorOf(() => cipher.decrypt(ORG, ctx, b64(mk("otherapp"))));
    const tampered = await errorOf(() => cipher.decrypt(ORG, ctx, b64(flip(mk("chartwarden")))));
    const legacy = await errorOf(() => cipher.decrypt(ORG, ctx, b64(mk("wardenx"))));
    expect(await cipher.decrypt(ORG, ctx, b64(mk("chartwarden")))).toBe("x");
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
  });

  it("M5", async () => {
    const dek = randomBytes(32);
    const keys: IdentifierKeyProvider = {
      dekForOrg: async () => ({ version: "1", key: dek }),
      dekForOrgVersion: async (_o, version) => ({ version, key: dek }),
    };
    const cipher = createPatientIdentifierCipher(keys);
    const row = "11111111-1111-4111-8111-111111111111";
    const mk = (prefix: string) => {
      const aad = `${prefix}:m5:patient_identifier:value_encrypted:v1:${ORG}:${row}:ssn`;
      const { nonce, ct, tag } = gcm(dek, Buffer.from("123456789"), aad);
      return Buffer.concat([Buffer.from([1, 1]), Buffer.from("1"), nonce, tag, ct]);
    };
    const wrong = await errorOf(() => cipher.open(ORG, row, "ssn", mk("otherapp")));
    const tampered = await errorOf(() => cipher.open(ORG, row, "ssn", flip(mk("chartwarden"))));
    const legacy = await errorOf(() => cipher.open(ORG, row, "ssn", mk("wardenx")));
    expect(await cipher.open(ORG, row, "ssn", mk("chartwarden"))).toBe("123456789");
    sameFailure(wrong, tampered);
    sameFailure(legacy, tampered);
    expect(wrong).toBeInstanceOf(IdentifierCipherIntegrityError);
  });
});
