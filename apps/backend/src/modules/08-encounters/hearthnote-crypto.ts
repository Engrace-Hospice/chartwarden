// apps/backend/src/modules/08-encounters/hearthnote-crypto.ts — the DEK envelopes over M8's two
// PHI-bearing text columns: `hearthnote_selection.free_text_cipher` (§3.6, #114) and
// `hearthnote_assembled_output.layer1_cipher` / `final_cipher` (§2.6, #122).
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
// another org fails to open rather than decrypting into the wrong chart. That is why there are TWO ciphers
// over one key rather than one cipher used twice: the selection tree's free text and the assembled
// narrative are different columns with different lifetimes (the eraser NULLs the first and crypto-shreds
// the second), and an envelope moved between them must fail rather than open. The DEK version travels in
// the envelope, and `open` resolves THAT version rather than the current one, so a key rotation leaves
// every historical note readable.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The M34 key-ring slice this module needs. `dekForOrgVersion` is what makes rotation survivable. */
export interface EncounterTenantKeyProvider {
  dekForOrg(organizationId: string): Promise<{ version: string; key: Buffer }>;
  dekForOrgVersion(
    organizationId: string,
    version: string,
  ): Promise<{ version: string; key: Buffer }>;
}

/** Seals and opens one PHI-bearing M8 text column. Absent from the deps ⇒ that column is REFUSED. */
export interface HearthnoteEnvelopeCipher {
  seal(organizationId: string, plaintext: string): Promise<string>;
  open(organizationId: string, envelope: string): Promise<string>;
}

/** Back-compat alias for the free-text envelope's original name (#114). */
export type HearthnoteFreeTextCipher = HearthnoteEnvelopeCipher;

/**
 * The two envelopes M8's write paths need. Both are backed by the SAME tenant DEK — they differ only in
 * AAD, which is the point (see the header). A service handed neither refuses both columns; one is never
 * bound without the other, because they come from one key provider.
 */
export interface HearthnoteCiphers {
  /** `hearthnote_selection.free_text_cipher` — the clinician's verbatim prose (§3.6). */
  readonly freeText: HearthnoteEnvelopeCipher;
  /** `hearthnote_assembled_output.layer1_cipher` / `final_cipher` — the assembled narrative (§2.6). */
  readonly narrative: HearthnoteEnvelopeCipher;
}

/** AES-256-GCM envelope: `v1.<dekVersion>.<nonce>.<tag>.<ciphertext>`, all base64url after the version. */
function createEnvelopeCipher(
  keys: EncounterTenantKeyProvider,
  aad: (organizationId: string) => Buffer,
): HearthnoteEnvelopeCipher {
  return {
    async seal(organizationId, plaintext) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== 32) throw new Error("tenant DEK must be 32 bytes");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(organizationId));
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
      decipher.setAAD(aad(organizationId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

/** The §3.6 free-text envelope over `hearthnote_selection.free_text_cipher` (#114). */
export function createHearthnoteFreeTextCipher(
  keys: EncounterTenantKeyProvider,
): HearthnoteEnvelopeCipher {
  return createEnvelopeCipher(keys, (organizationId) =>
    Buffer.from(`m8:hearthnote_selection:free_text:${organizationId}`, "utf8"),
  );
}

/**
 * The §2.6 narrative envelope over `hearthnote_assembled_output.layer1_cipher` / `final_cipher` (#122).
 * One AAD covers both columns: they are the same narrative at two points in the Layer-1 → Layer-2 →
 * final pipeline, and in Phase 1 (Layer-2 kill-switched off) they hold byte-identical text — an AAD that
 * distinguished them would only assert a difference the data does not have.
 */
export function createHearthnoteNarrativeCipher(
  keys: EncounterTenantKeyProvider,
): HearthnoteEnvelopeCipher {
  return createEnvelopeCipher(keys, (organizationId) =>
    Buffer.from(`m8:hearthnote_assembled_output:narrative:${organizationId}`, "utf8"),
  );
}

/** Both M8 envelopes over one tenant-key provider — what the composition root binds. */
export function createHearthnoteCiphers(keys: EncounterTenantKeyProvider): HearthnoteCiphers {
  return {
    freeText: createHearthnoteFreeTextCipher(keys),
    narrative: createHearthnoteNarrativeCipher(keys),
  };
}
