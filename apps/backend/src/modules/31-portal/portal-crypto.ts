// apps/backend/src/modules/31-portal/portal-crypto.ts — the DEK envelope over M31's one operator-written
// free-text column, `portal_account.status_change_reason_cipher` (#117).
//
// Mirrors M39's `consent-crypto.ts` exactly, including the port shape: the key provider is INJECTED, so
// this file takes no edge on M34 and the composition root binds `getTenantKeyProvider()`. The AAD binds
// the ciphertext to (module, table, column, tenant), so a blob lifted from another column or another org
// fails to open rather than decrypting into the wrong context.
//
// There is deliberately no `decrypt` on the REASON cipher. Nothing reads the reason back yet — the admin roster projects
// ids, enums and instants and never a cipher (the store's own rule) — and shipping an unused decrypt path
// would be a PHI read surface with no audit behind it. The version prefix is what makes adding one later
// safe: the DEK version travels with the blob, so rotation keeps historical rows openable.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this module needs: one per-tenant DEK, versioned. */
export interface PortalTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  /** GAP-095 — the historical DEK a sealed blob names (rotation keeps old blobs openable). */
  dekForOrgVersion?(
    organizationId: string,
    version: string,
  ): Promise<{ version: string; key: Buffer }>;
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
// `consent-crypto.ts` / M8 `hearthnote-crypto.ts` / this file's reason cipher). GAP-095: the join route now opens the sealed url to hand
// the caller the real vendor room, and `/end` opens the id to close it at the vendor (previously unread — see `outbox-consumers/m17-visit-cancelled-
// telehealth.ts`), and an unused decrypt would be a PHI read surface with no audit behind it. The AAD binds the blob to
// (module, table, column, tenant), so a room id lifted into the url column — or into another org — fails to open.

/** The two sealed vendor-room columns. */
export type PortalRoomColumn = "vendor_room_id" | "vendor_room_url";

/** Seals one vendor-room value for one tenant. */
export interface PortalRoomCipher {
  encrypt(organizationId: string, column: PortalRoomColumn, plaintext: string): Promise<string>;
  /**
   * GAP-095 — opens a sealed room value so the join route can hand the caller the REAL vendor url (and the
   * end route can address the vendor room). Throws on a malformed / foreign / tampered blob.
   */
  decrypt(organizationId: string, column: PortalRoomColumn, envelope: string): Promise<string>;
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
    async decrypt(organizationId, column, envelope) {
      // `v1.<dekVersion>.<nonce>.<tag>.<ct>` — base64url parts never contain "."; the version may.
      const parts = envelope.split(".");
      const [v] = parts;
      const [nonce, tag, ct] = parts.slice(-3);
      const version = parts.slice(1, -3).join(".");
      if (v !== "v1" || parts.length < 5 || !version || !nonce || !tag || ct === undefined) {
        throw new Error("unrecognised telehealth_visit room envelope");
      }
      if (!keys.dekForOrgVersion)
        throw new Error("tenant key provider cannot open a versioned DEK");
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      d.setAAD(Buffer.from(`m31:telehealth_visit:${column}:${organizationId}`, "utf8"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    },
  };
}

// ── GAP-092: the account contact columns + the staged-upload bytes ───────────────────────────────────────────────
// `portal_account.{display_name,email,phone}_cipher` (written at invitation issue) and
// `portal_document_upload.content_cipher` (the encrypted STAGING of a caregiver's upload) seal under the SAME
// per-tenant DEK provider. Unlike the reason / room ciphers this one OPENS what it seals, because the staged bytes
// must be handed to M22 on `upload-complete`. The AAD binds the blob to (module, table.column, tenant), so a blob
// lifted into another column or another org fails to open.

/** The sealed columns this cipher serves. */
export type PortalPhiColumn =
  | "portal_account.display_name_cipher"
  | "portal_account.email_cipher"
  | "portal_account.phone_cipher"
  | "portal_document_upload.content_cipher";

export interface PortalPhiCipher {
  /** Seal `plaintext`; `keyVersion` is the integer a `*_key_version` column records. */
  encrypt(
    organizationId: string,
    column: PortalPhiColumn,
    plaintext: Buffer | string,
  ): Promise<{ readonly envelope: string; readonly keyVersion: number }>;
  decrypt(organizationId: string, column: PortalPhiColumn, envelope: string): Promise<Buffer>;
}

const phiAad = (organizationId: string, column: PortalPhiColumn): Buffer =>
  Buffer.from(`m31:${column}:${organizationId}`, "utf8");

/** `v3` / `2026.v12` becomes the trailing run of numerals; anything without one becomes 1 (the integer column's default). */
function dekVersionInt(version: string): number {
  const runs = version.match(/\d+/g);
  const last = runs?.[runs.length - 1];
  const n = last === undefined ? 1 : Number.parseInt(last, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

export function createPortalPhiCipher(keys: PortalTenantKeyProvider): PortalPhiCipher {
  return {
    async encrypt(organizationId, column, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(phiAad(organizationId, column));
      const ciphertext = Buffer.concat([
        cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
        cipher.final(),
      ]);
      const envelope = [
        "v1",
        Buffer.from(version, "utf8").toString("base64url"),
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
      return { envelope, keyVersion: dekVersionInt(version) };
    },
    async decrypt(organizationId, column, envelope) {
      const [v, versionB64, nonce, tag, ct] = envelope.split(".");
      if (v !== "v1" || !versionB64 || !nonce || !tag || ct === undefined) {
        throw new Error("unrecognised portal PHI envelope");
      }
      if (!keys.dekForOrgVersion)
        throw new Error("tenant key provider cannot open a versioned DEK");
      const version = Buffer.from(versionB64, "base64url").toString("utf8");
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      d.setAAD(phiAad(organizationId, column));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
    },
  };
}
