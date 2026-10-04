// apps/backend/src/modules/22-documents/extraction/candidate-value-cipher.ts — the per-tenant DEK envelope
// for `extraction_candidate.value_cipher` (M22 §3.3 / §3.6; F-235, #248).
//
// An extracted field value is PHI lifted off a referral fax. It is stored ONLY as an AES-256-GCM envelope
// under the M34 tenant DEK (the `TenantKeyProvider` M12/M31/M39 ciphers use), AAD bound to
// (module, table, column, org) so a ciphertext copied into another tenant's row cannot be opened. The DEK
// VERSION travels inside the envelope (`v1.<dekVersion>.<nonce>.<tag>.<ct>`, the M39 consent-notes
// precedent — this table has no separate wrapped-DEK column), so a rotated key ring still decrypts.
//
// The writeback commit decrypts on the SERVER from the stored row; a value is never taken from a client at
// commit time.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The slice of M34's `TenantKeyProvider` this cipher needs (structural — M22 has no M34 edge). */
export interface CandidateValueKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

export interface CandidateValueCipher {
  encrypt(organizationId: string, plaintext: string): Promise<string>;
  decrypt(organizationId: string, envelope: string): Promise<string>;
}

const aad = (organizationId: string): Buffer =>
  Buffer.from(`m22:extraction_candidate:value_cipher:${organizationId}`, "utf8");

export function createCandidateValueCipher(keys: CandidateValueKeyProvider): CandidateValueCipher {
  return {
    async encrypt(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aad(organizationId));
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return [
        "v1",
        Buffer.from(version, "utf8").toString("base64url"),
        nonce.toString("base64url"),
        c.getAuthTag().toString("base64url"),
        ct.toString("base64url"),
      ].join(".");
    },
    async decrypt(organizationId, envelope) {
      const [v, versionB64, nonce, tag, ct] = envelope.split(".");
      if (v !== "v1" || !versionB64 || !nonce || !tag || ct === undefined) {
        throw new Error("unrecognised extraction_candidate value envelope");
      }
      const version = Buffer.from(versionB64, "base64url").toString("utf8");
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      d.setAAD(aad(organizationId));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    },
  };
}
