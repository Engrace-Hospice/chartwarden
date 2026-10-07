// apps/backend/src/modules/16-bereavement/bereavement-crypto.ts — the per-tenant DEK envelope for M16's four
// `*_cipher` columns (GAP-129): `bereaved_contact.{email,phone,mailing_address}_cipher` and
// `bereavement_contact_log.contact_notes_cipher`.
//
// Mirrors M31's `portal-crypto.ts` / M39's `consent-crypto.ts` / M12's `body-crypto.ts`: AES-256-GCM, the tenant DEK
// resolved through an INJECTED key provider (the composition root binds M34's `getTenantKeyProvider()`, so this file
// takes no edge on M34), and the AAD bound to (module, table, column, tenant) so a blob lifted into another column or
// another org fails to open. The DEK VERSION travels inside the blob (`v1.<dekVersion>.<nonce>.<tag>.<ciphertext>`),
// so rotation keeps historical rows openable via `dekForOrgVersion`.
//
// Before this, every `*_cipher` column was written NULL and a counselor's phone number, email and notes were
// discarded — the 13-month program had no stored way to contact anyone (GAP-129).
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this module needs. */
export interface BereavementKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion?(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

/** The four sealed columns. */
export type BereavementCipherColumn =
  | "bereaved_contact.email"
  | "bereaved_contact.phone"
  | "bereaved_contact.mailing_address"
  | "bereavement_contact_log.contact_notes";

export interface BereavementCipher {
  encrypt(
    organizationId: string,
    column: BereavementCipherColumn,
    plaintext: string,
  ): Promise<string>;
  decrypt(organizationId: string, column: BereavementCipherColumn, blob: string): Promise<string>;
}

const BLOB_VERSION = "v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

const aad = (organizationId: string, column: BereavementCipherColumn): Buffer =>
  Buffer.from(`m16:${column}:${organizationId}`, "utf8");

export function createBereavementCipher(keys: BereavementKeyProvider): BereavementCipher {
  return {
    async encrypt(organizationId, column, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== KEY_BYTES) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(organizationId, column));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        BLOB_VERSION,
        version,
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    async decrypt(organizationId, column, blob) {
      const [v, dekVersion, nonce, tag, ct] = blob.split(".");
      if (v !== BLOB_VERSION || !dekVersion || !nonce || !tag || !ct) {
        throw new Error("unrecognised bereavement cipher blob");
      }
      const { key } = keys.dekForOrgVersion
        ? await keys.dekForOrgVersion(organizationId, dekVersion)
        : await keys.dekForOrg(organizationId);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAAD(aad(organizationId, column));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
