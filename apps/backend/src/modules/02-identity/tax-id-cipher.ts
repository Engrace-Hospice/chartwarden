// apps/backend/src/modules/02-identity/tax-id-cipher.ts — the envelope cipher for `provider_entity.tax_id_encrypted`.
//
// The EIN is sealed under the tenant's OWN DEK from M34's key ring, the same shape as M20's `safety-crypto` and M8's
// `hearthnote-crypto`: the key provider is INJECTED (the composition root binds `getTenantKeyProvider()`, so M2 takes no
// edge on M34), AES-256-GCM, and the DEK version travels in the envelope so a key rotation leaves historical rows
// openable. The AAD binds the blob to this purpose AND the tenant, so a blob lifted into another tenant, or into another
// column sealed under the same DEK, refuses to open instead of decrypting into the wrong record.
//
// Stored value (the `tax_id_encrypted` text column): `v1.<dekVersion>.<nonce>.<tag>.<ciphertext>`, base64url parts.
// Fail-closed: an unbound key ring throws from `dekForOrg`, so there is no path that stores an EIN in the clear.
// `decrypt` exists to prove the format and for a future billing/support reader; no route returns a tax id.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this module needs. `dekForOrgVersion` is what makes rotation survivable. */
export interface TaxIdKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ version: string; key: Buffer }>;
}

export interface TaxIdCipher {
  encrypt(input: { organizationId: string; plaintext: string }): Promise<string>;
  decrypt(input: { organizationId: string; sealed: string }): Promise<string>;
}

const SCHEME = "v1";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
/** GCM tag length, pinned on decrypt: without it Node accepts a truncated (4-15 byte) tag. */
const TAG_BYTES = 16;

const aadFor = (organizationId: string): Buffer =>
  Buffer.from(`m2:provider_entity:tax_id:${organizationId}`, "utf8");

export function createTaxIdCipher(keys: TaxIdKeyProvider): TaxIdCipher {
  return {
    async encrypt({ organizationId, plaintext }) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== DEK_BYTES) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aadFor(organizationId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        SCHEME,
        version,
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },

    async decrypt({ organizationId, sealed }) {
      const [scheme, version, nonce, tag, ciphertext] = sealed.split(".");
      if (scheme !== SCHEME || !version || !nonce || !tag || ciphertext === undefined) {
        throw new Error("tax-id envelope is malformed");
      }
      const authTag = Buffer.from(tag, "base64url");
      if (authTag.byteLength !== TAG_BYTES) throw new Error("tax-id envelope is malformed");
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadFor(organizationId));
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
