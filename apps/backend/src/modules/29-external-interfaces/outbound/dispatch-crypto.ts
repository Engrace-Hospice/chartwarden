// apps/backend/src/modules/29-external-interfaces/outbound/dispatch-crypto.ts — the DEK envelope over
// `hl7_message_outbound.payload_cipher` / `.ack_payload_cipher` (M29-T08, F-175/#248).
//
// PER-ORG DEK, NOT M35's PLATFORM-SINGLETON ONE. An outbound HL7 ORM is one tenant's patient's PHI, so
// this seals under M34's tenant key-ring (`getTenantKeyProvider().dekForOrg(orgId)`, the `m27-jobs.ts`
// precedent around its own §WX-PR-013 note, and `apps/backend/src/bootstrap/tenant-kek.ts` for the
// underlying wrap/unwrap the seam composes over) — never M35's KMS-platform DEK (that seam exists for a
// different, platform-wide secret class entirely).
//
// Mirrors `apps/backend/src/modules/31-portal/portal-crypto.ts`'s shape (AES-256-GCM, the DEK version
// embedded so rotation keeps historical rows openable, an AAD that binds module+table+column+tenant so a
// blob lifted from another column or another org fails to open). UNLIKE that precedent, this file DOES ship
// a `decrypt`: a scheduled retry re-sends the SAME wire bytes on a LATER worker tick (possibly a different
// process), so the plaintext wire must be recoverable from the persisted `payload_cipher` — there is a real
// reader, not merely a future one, so shipping decrypt here does not repeat that file's "unused PHI read
// surface" concern.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this file needs — the real `TenantKeyProvider` (`@wardenx/saas-tenant-platform`)
 *  satisfies this structurally; declared locally so this module never imports the seam package directly
 *  (the M29/M22 `getSeam`-opaque-resolution precedent, applied to an injected port instead since the
 *  composition root already holds a concrete `TenantKeyProvider` instance for M27/M31/M39's identical use). */
export interface OutboundTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ readonly version: string; readonly key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ readonly version: string; readonly key: Buffer }>;
}

/** Seals/opens one `hl7_message_outbound` cipher column for one tenant. */
export interface OutboundPayloadCipher {
  /** Encrypts under the org's CURRENT active DEK. `column` is `'payload'` or `'ack_payload'` — folded into
   *  the AAD so a `payload_cipher` blob can never be replayed into `ack_payload_cipher` or vice versa. */
  encrypt(organizationId: string, column: "payload" | "ack_payload", plaintext: string): Promise<string>;
  /** Opens a blob sealed by `encrypt` — resolves the DEK VERSION embedded in the blob (never assumes it is
   *  still the current active version; a retry may run after a KEK/DEK rotation). */
  decrypt(organizationId: string, column: "payload" | "ack_payload", sealed: string): Promise<string>;
}

const AAD_PREFIX = "m29:hl7_message_outbound";

function aad(column: string, organizationId: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}:${column}:${organizationId}`, "utf8");
}

/** AES-256-GCM envelope; format `v1.<dekVersion>.<nonceB64url>.<tagB64url>.<ciphertextB64url>` — the
 *  `portal-crypto.ts` / `consent-crypto.ts` house format, so a reviewer already fluent in one reads this. */
export function createOutboundPayloadCipher(keys: OutboundTenantKeyProvider): OutboundPayloadCipher {
  return {
    async encrypt(organizationId, column, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(column, organizationId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        "v1",
        version,
        nonce.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    async decrypt(organizationId, column, sealed) {
      const parts = sealed.split(".");
      if (parts.length !== 5 || parts[0] !== "v1") {
        throw new Error("malformed hl7_message_outbound cipher envelope");
      }
      const [, version, nonceB64, tagB64, ciphertextB64] = parts as [
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
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, "base64url")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    },
  };
}
