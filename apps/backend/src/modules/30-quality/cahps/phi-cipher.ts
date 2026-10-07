// apps/backend/src/modules/30-quality/cahps/phi-cipher.ts — GAP-087. The per-tenant DEK envelope M30's CAHPS
// pipeline seals PHI under: the caregiver contact on `cahps_decedent_sample`, the rendered vendor file on
// `cahps_export_job`, and the vendor-binding configuration (API keys) on `cahps_vendor_binding`.
//
// AES-256-GCM, AAD bound to (module, table, column, tenant) so a blob lifted into another column or another org
// fails to open. The DEK VERSION travels inside the envelope (`v1.<b64url version>.<nonce>.<tag>.<ct>`, the
// M22 candidate-value / M39 consent-notes precedent) so a rotated key ring still opens historical rows. The key
// provider is INJECTED (structural slice of M34's `TenantKeyProvider`), so M30 takes no M34 edge.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The slice of M34's `TenantKeyProvider` this cipher needs. */
export interface CahpsKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

/** The three sealed columns (the AAD names them, so a blob never opens as a different column). */
export type CahpsSealedColumn =
  | "cahps_decedent_sample.primary_caregiver_contact_cipher"
  | "cahps_export_job.file_cipher"
  | "cahps_vendor_binding.configuration_cipher";

export interface CahpsPhiCipher {
  /** Seal `plaintext`; `keyVersion` is the integer the `*_key_version` columns record. */
  encrypt(
    organizationId: string,
    column: CahpsSealedColumn,
    plaintext: Buffer | string,
  ): Promise<{ readonly envelope: string; readonly keyVersion: number }>;
  decrypt(organizationId: string, column: CahpsSealedColumn, envelope: string): Promise<Buffer>;
}

const aad = (organizationId: string, column: CahpsSealedColumn): Buffer =>
  Buffer.from(`m30:${column}:${organizationId}`, "utf8");

/** `v3` / `3` / `2026-09-01.v3` → 3; anything without a digit run → 1 (the integer column's default). */
export function keyVersionInt(version: string): number {
  const digits = version.match(/\d+/g);
  const last = digits?.[digits.length - 1];
  const n = last === undefined ? 1 : Number.parseInt(last, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

export function createCahpsPhiCipher(keys: CahpsKeyProvider): CahpsPhiCipher {
  return {
    async encrypt(organizationId, column, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aad(organizationId, column));
      const ct = Buffer.concat([
        c.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
        c.final(),
      ]);
      const envelope = [
        "v1",
        Buffer.from(version, "utf8").toString("base64url"),
        nonce.toString("base64url"),
        c.getAuthTag().toString("base64url"),
        ct.toString("base64url"),
      ].join(".");
      return { envelope, keyVersion: keyVersionInt(version) };
    },
    async decrypt(organizationId, column, envelope) {
      const [v, versionB64, nonce, tag, ct] = envelope.split(".");
      if (v !== "v1" || !versionB64 || !nonce || !tag || ct === undefined) {
        throw new Error("unrecognised CAHPS PHI envelope");
      }
      const version = Buffer.from(versionB64, "base64url").toString("utf8");
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      d.setAAD(aad(organizationId, column));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
    },
  };
}
