// apps/backend/src/modules/12-dosespot/webhooks/body-crypto.ts — the per-tenant DEK envelope for
// `dosespot_webhook_event.raw_body_cipher` (M12 §7.4.5 / §7.6; F-230, #248). AES-256-GCM, tenant DEK resolved
// through M34's `TenantKeyProvider` (the same provider M39 consent notes / M31 portal ciphers use), AAD bound
// to (module, table, org) so a ciphertext copied into another tenant's row cannot be opened. The DEK VERSION
// is stored in `raw_body_dek` (the column is "wrapped DEK ref"; the DEK itself is never persisted here).
// The body is PHI-bearing vendor traffic and is never logged in the clear (§7.4.7).
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface DoseSpotWebhookKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion?(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

export interface WebhookBodyCipher {
  encrypt(
    organizationId: string,
    plaintext: string,
  ): Promise<{ readonly cipher: string; readonly dekRef: string }>;
  decrypt(organizationId: string, cipher: string, dekRef: string): Promise<string>;
}

const aad = (organizationId: string): Buffer =>
  Buffer.from(`m12:dosespot_webhook_event:raw_body:${organizationId}`, "utf8");

export function createWebhookBodyCipher(keys: DoseSpotWebhookKeyProvider): WebhookBodyCipher {
  return {
    async encrypt(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aad(organizationId));
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      const tag = c.getAuthTag();
      return {
        cipher: [
          "v1",
          nonce.toString("base64url"),
          tag.toString("base64url"),
          ct.toString("base64url"),
        ].join("."),
        dekRef: version,
      };
    },
    async decrypt(organizationId, cipher, dekRef) {
      const [v, nonce, tag, ct] = cipher.split(".");
      if (v !== "v1" || !nonce || !tag || !ct) throw new Error("unrecognised webhook body cipher");
      const { key } = keys.dekForOrgVersion
        ? await keys.dekForOrgVersion(organizationId, dekRef)
        : await keys.dekForOrg(organizationId);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      d.setAAD(aad(organizationId));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    },
  };
}
