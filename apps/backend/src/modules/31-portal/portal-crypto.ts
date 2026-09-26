// apps/backend/src/modules/31-portal/portal-crypto.ts — the DEK envelope over M31's one operator-written
// free-text column, `portal_account.status_change_reason_cipher` (#117).
//
// Mirrors M39's `consent-crypto.ts` exactly, including the port shape: the key provider is INJECTED, so
// this file takes no edge on M34 and the composition root binds `getTenantKeyProvider()`. The AAD binds
// the ciphertext to (module, table, column, tenant), so a blob lifted from another column or another org
// fails to open rather than decrypting into the wrong context.
//
// There is deliberately no `decrypt` here. Nothing reads the reason back yet — the admin roster projects
// ids, enums and instants and never a cipher (the store's own rule) — and shipping an unused decrypt path
// would be a PHI read surface with no audit behind it. The version prefix is what makes adding one later
// safe: the DEK version travels with the blob, so rotation keeps historical rows openable.
import { createCipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this module needs: one per-tenant DEK, versioned. */
export interface PortalTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
}

/** Seals one operator-written reason for one tenant. Absent from `PortalRouteDeps` ⇒ the route refuses. */
export interface PortalReasonCipher {
  encrypt(organizationId: string, plaintext: string): Promise<string>;
}

/** AES-256-GCM envelope; the DEK version is embedded so rotation retains decryptability. */
export function createPortalReasonCipher(keys: PortalTenantKeyProvider): PortalReasonCipher {
  return {
    async encrypt(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(
        Buffer.from(`m31:portal_account:status_change_reason:${organizationId}`, "utf8"),
      );
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
  };
}
