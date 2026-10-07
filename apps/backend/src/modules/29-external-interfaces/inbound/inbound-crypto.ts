// apps/backend/src/modules/29-external-interfaces/inbound/inbound-crypto.ts — GAP-086. The per-tenant DEK envelope
// over the INBOUND side's sealed columns: `hl7_message_inbound.payload_cipher` / `.parsed_segments_cipher` and
// `external_feed_credential.secret_cipher` (the listener's mTLS bundle).
//
// Same AES-256-GCM `v1.<dekVersion>.<nonce>.<tag>.<ct>` house format as `outbound/dispatch-crypto.ts`; the AAD binds
// module + table + column + tenant, so a blob lifted into another column or another org fails to open, and the DEK
// version rides in the envelope so a rotated key ring still opens historical rows. The key provider is INJECTED
// (structural slice of M34's `TenantKeyProvider`).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface InboundTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

/** The sealed inbound-side columns (each names its own AAD). */
export type InboundSealedColumn =
  | "hl7_message_inbound.payload"
  | "hl7_message_inbound.parsed_segments"
  | "external_feed_credential.secret";

export interface InboundCipher {
  encrypt(organizationId: string, column: InboundSealedColumn, plaintext: string): Promise<string>;
  decrypt(organizationId: string, column: InboundSealedColumn, sealed: string): Promise<string>;
}

const aad = (column: InboundSealedColumn, organizationId: string): Buffer =>
  Buffer.from(`m29:${column}:${organizationId}`, "utf8");

/** True when `value` has the shape of an envelope this cipher wrote (vs a legacy sha256 digest). */
export function isSealedEnvelope(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 5 && parts[0] === "v1";
}

export function createInboundCipher(keys: InboundTenantKeyProvider): InboundCipher {
  return {
    async encrypt(organizationId, column, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(column, organizationId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        "v1",
        version,
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    async decrypt(organizationId, column, sealed) {
      const parts = sealed.split(".");
      if (parts.length !== 5 || parts[0] !== "v1") {
        throw new Error(`malformed ${column} cipher envelope`);
      }
      const [, version, nonceB64, tagB64, ctB64] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceB64, "base64url"));
      decipher.setAAD(aad(column, organizationId));
      decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
