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

// ── F-220 (#248): the two `telehealth_visit` vendor-room columns ─────────────────────────────────────────────
// `vendor_room_id_cipher` / `vendor_room_url_cipher` (both NOT NULL, §3.6 audit-denylisted) are written once, at
// the lazy room mint, through the SAME per-tenant DEK provider (`dekForOrg`/`getTenantKeyProvider`, the M39
// `consent-crypto.ts` / M8 `hearthnote-crypto.ts` / this file's reason cipher). Encrypt-only for the same reason as
// the reason cipher: nothing reads a vendor room id back (the join route mints per-participant tokens from the
// telehealth visit id, and the staff `/end` route never calls `endRoom` — see `outbox-consumers/m17-visit-cancelled-
// telehealth.ts`), and an unused decrypt would be a PHI read surface with no audit behind it. The AAD binds the blob to
// (module, table, column, tenant), so a room id lifted into the url column — or into another org — fails to open.

/** The two sealed vendor-room columns. */
export type PortalRoomColumn = "vendor_room_id" | "vendor_room_url";

/** Seals one vendor-room value for one tenant. */
export interface PortalRoomCipher {
  encrypt(organizationId: string, column: PortalRoomColumn, plaintext: string): Promise<string>;
}

/** AES-256-GCM envelope over the two `telehealth_visit` room columns; DEK version embedded for rotation. */
export function createPortalRoomCipher(keys: PortalTenantKeyProvider): PortalRoomCipher {
  return {
    async encrypt(organizationId, column, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`m31:telehealth_visit:${column}:${organizationId}`, "utf8"));
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
