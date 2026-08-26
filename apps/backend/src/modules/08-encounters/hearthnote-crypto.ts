// apps/backend/src/modules/08-encounters/hearthnote-crypto.ts — the DEK envelope over
// `hearthnote_selection.free_text_cipher` (§3.6, #114).
//
// Mirrors M39's `consent-crypto.ts` and M31's `portal-crypto.ts`, with one addition they do not need:
// this one DECRYPTS. The two of them seal a field nothing reads back; a clinical note that cannot be read
// back is the defect this file exists to fix, so `open` is part of the contract from the start.
//
// WHAT IS SEALED AND WHAT IS NOT. `selections` holds vocabulary CODES and their numeric slot params — a
// structured tree of identifiers, stored in the clear so the assembly engine, the Layer-3 gate and the
// eraser can all work with it. `free_text_cipher` holds only the clinician's verbatim prose, keyed by
// section. That split IS the §3.6 PHI-minimization rule: the codes are a controlled vocabulary, the prose
// is unbounded and is the part that must never sit readable at rest or enter `audit_event`.
//
// The AAD binds the ciphertext to (module, table, column, tenant), so a blob lifted from another column or
// another org fails to open rather than decrypting into the wrong chart. The DEK version travels in the
// envelope, and `open` resolves THAT version rather than the current one, so a key rotation leaves every
// historical note readable.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this module needs. `dekForOrgVersion` is what makes rotation survivable. */
export interface EncounterTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ version: string; key: Buffer }>;
}

/** Seals and opens one encounter's free-text annotations. Absent from the deps ⇒ free text is REFUSED. */
export interface HearthnoteFreeTextCipher {
  seal(organizationId: string, plaintext: string): Promise<string>;
  open(organizationId: string, envelope: string): Promise<string>;
}

const AAD = (organizationId: string): Buffer =>
  Buffer.from(`m8:hearthnote_selection:free_text:${organizationId}`, "utf8");

/** AES-256-GCM envelope: `v1.<dekVersion>.<nonce>.<tag>.<ciphertext>`, all base64url after the version. */
export function createHearthnoteFreeTextCipher(
  keys: EncounterTenantKeyProvider,
): HearthnoteFreeTextCipher {
  return {
    async seal(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(AAD(organizationId));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        "v1",
        version,
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    async open(organizationId, envelope) {
      const [scheme, version, nonce, tag, ciphertext] = envelope.split(".");
      if (scheme !== "v1" || !version || !nonce || !tag || ciphertext === undefined) {
        throw new Error("hearthnote free-text envelope is malformed");
      }
      const { key } = await keys.dekForOrgVersion(organizationId, version);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAAD(AAD(organizationId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
