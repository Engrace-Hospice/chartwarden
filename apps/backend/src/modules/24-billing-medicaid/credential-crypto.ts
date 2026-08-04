// apps/backend/src/modules/24-billing-medicaid/credential-crypto.ts — M24 §3.6/§8.7 trading-partner
// secret envelope encryption.
//
// The state trading-partner credential carries two secrets — the MMIS/clearinghouse client secret and the
// SFTP private key — which the per-state adapter needs in PLAINTEXT at submit time and which must never be
// readable at rest, never returned to a browser, and never logged. This module is the only place either
// crosses that boundary.
//
// It replaces a placeholder that was worse than it looked: the upsert path wrote the literal string
// "ENC:deferred" into `client_secret_cipher`, so a submitted secret was silently DISCARDED while
// `hasClientSecret` went on reporting `true` — the admin screen showed "Set" for a secret that did not
// exist, and the eventual adapter bind would have found garbage. Storing nothing is safe; claiming to have
// stored something you dropped is not.
//
// KEY MODEL (architecture §8(2), the M36 `body-crypto` precedent). A single master KEK
// (M24_CREDENTIAL_ENCRYPTION_KEY, 32 bytes base64) is the root; each tenant's DEK is HKDF-SHA256-derived
// from the KEK + the org id, so the DEK is deterministic (no per-tenant key table in Phase 1) yet
// tenant-scoped, and the §7.8 crypto-erase of a tenant is modelled by forgetting its derived key. The HKDF
// `info` label is M24-specific, so an M24 cipher can never be opened with an M36 message DEK even under the
// same KEK. Fail-closed: a missing or short KEK THROWS, so the write path can never silently fall back to
// plaintext or a zero key.
//
// AT-REST FORMAT (the `*_cipher` text columns): base64 of
//     version(1 byte) ‖ nonce(12) ‖ ciphertext ‖ tag(16)          — AES-256-GCM
// base64 (not bytea) because the §3.3 columns are `text`; the envelope is binary and self-describing, so a
// future migration to bytea is a decode, not a re-encrypt.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_LEN = 1 + NONCE_LEN + TAG_LEN; // header + tag, even with an empty ciphertext
const DEK_INFO_PREFIX = "wardenx-m24-trading-partner-dek:"; // HKDF `info` label — org-bound AND module-bound

/** The sentinel the pre-crypto placeholder wrote. Recognised so a legacy row reads as "no usable secret". */
export const LEGACY_DEFERRED_SENTINEL = "ENC:deferred";

/** Load the 32-byte master KEK from M24_CREDENTIAL_ENCRYPTION_KEY (base64). Fail-closed. */
export function loadCredentialKek(
  raw: string | undefined = process.env.M24_CREDENTIAL_ENCRYPTION_KEY,
): Buffer {
  if (!raw) {
    throw new Error(
      "M24_CREDENTIAL_ENCRYPTION_KEY is required (Medicaid trading-partner secret encryption — fail-closed)",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(
      `M24_CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`,
    );
  }
  return key;
}

/** Derive a tenant's 32-byte credential DEK from the master KEK + org id (HKDF-SHA256, org-bound). */
export function deriveOrgCredentialDek(kek: Buffer, orgId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", kek, Buffer.alloc(0), `${DEK_INFO_PREFIX}${orgId}`, KEY_LEN),
  );
}

/** Seal a secret → base64 envelope (fresh random nonce per call) under the tenant DEK. */
export function sealCredentialSecret(plaintext: string, dek: Buffer): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, tag]).toString("base64");
}

/**
 * Open a base64 envelope. Throws on a wrong DEK, tampering (GCM auth failure), bad version, or the legacy
 * "ENC:deferred" placeholder — a caller must never treat an unopenable cipher as an empty secret and
 * proceed to submit with no credential.
 */
export function openCredentialSecret(cipherB64: string, dek: Buffer): string {
  if (cipherB64 === LEGACY_DEFERRED_SENTINEL) {
    throw new Error(
      "M24 credential: this credential predates secret encryption and holds no usable secret — re-enter it",
    );
  }
  const raw = Buffer.from(cipherB64, "base64");
  if (raw.length < MIN_LEN) throw new Error("M24 credential-crypto: malformed ciphertext");
  if (raw[0] !== VERSION) throw new Error(`M24 credential-crypto: unsupported version ${raw[0]}`);
  const nonce = raw.subarray(1, 1 + NONCE_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(1 + NONCE_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Whether a stored cipher column represents a REAL, openable secret. The read surface's presence flags go
 * through this, so a legacy placeholder row reports "not configured" (the truth) instead of "Set".
 */
export function isUsableCipher(cipher: string | null | undefined): boolean {
  return typeof cipher === "string" && cipher.length > 0 && cipher !== LEGACY_DEFERRED_SENTINEL;
}

/** The port the write path binds — injectable so a test can seal without a process-wide KEK. */
export interface CredentialCipherPort {
  seal(orgId: string, plaintext: string): string;
  open(orgId: string, cipher: string): string;
}

/**
 * The production cipher port over the env-provided KEK. The KEK is read ONCE at construction (boot), so a
 * missing key fails the composition root rather than the first tenant write.
 */
export function buildCredentialCipherPort(kek: Buffer = loadCredentialKek()): CredentialCipherPort {
  return {
    seal: (orgId, plaintext) => sealCredentialSecret(plaintext, deriveOrgCredentialDek(kek, orgId)),
    open: (orgId, cipher) => openCredentialSecret(cipher, deriveOrgCredentialDek(kek, orgId)),
  };
}
