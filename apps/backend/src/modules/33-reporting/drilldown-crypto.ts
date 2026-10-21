// apps/backend/src/modules/33-reporting/drilldown-crypto.ts - the per-tenant envelope over the drilldown
// audit's filter context (`report_drilldown_audit.query_filters_cipher`, spec section 3.6).
//
// The filter context can carry patient ids and free-form dimension values, so it is never stored in the clear.
// Mirrors M31's `portal-crypto.ts` and M39's `consent-crypto.ts`: the key provider is INJECTED (the composition
// root binds `getTenantKeyProvider()`, so this file takes no edge on M34), the DEK version travels with the blob
// so rotation keeps historical rows openable, and the AAD binds the blob to (module, table, column, tenant) so a
// ciphertext lifted into another column or another org fails to open.
//
// There is deliberately no decrypt: nothing reads the filters back, and an unused decrypt path would be a PHI
// read surface with no audit behind it.
import { createCipheriv, randomBytes } from "node:crypto";
import type { DrilldownFilterEncryptionPort } from "@chartwarden/reporting";

const DEK_BYTES = 32;
const GCM_NONCE_BYTES = 12;

/** The M34 key-ring slice this module needs: one per-tenant DEK, versioned. */
export interface DrilldownTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
}

/** AES-256-GCM envelope `v1.<dekVersion>.<nonce>.<tag>.<ciphertext>`. Any failure rejects (fail-closed deny). */
export function createDrilldownFilterEncryption(
  keys: DrilldownTenantKeyProvider,
): DrilldownFilterEncryptionPort {
  return {
    async encryptFilters({ organizationId, plaintext }) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== DEK_BYTES) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(GCM_NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(
        Buffer.from(`m33:report_drilldown_audit:query_filters:${organizationId}`, "utf8"),
      );
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        "v1",
        version,
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
  };
}
