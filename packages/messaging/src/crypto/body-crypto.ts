// @wardenx/messaging · crypto — message body envelope encryption (M36 §3.4 / M36-F03, FB-T05).
//
// Per-tenant DEK envelope crypto for `message.body_cipher` (bytea). SERVER-ONLY (node:crypto) —
// the package is never bundled into the browser (the apps/web slices import @wardenx/ui only), so
// this sits beside the webhook HMAC verifiers that already use node:crypto.
//
// KEY MODEL (architecture §8(2) / M36-T10 eraser). A single master KEK (MESSAGING_ENCRYPTION_KEY,
// 32 bytes base64) is the root; each tenant's DEK is HKDF-SHA256-derived from the KEK + the org id,
// so the DEK is deterministic (no per-tenant key table to wire in Phase 1) yet tenant-scoped — and
// "destroying the tenant DEK" (the M36-T10 §7.8 crypto-erase) is modelled by forgetting the org's
// derived key. Fail-closed: a missing/short KEK throws, so the write path never silently stores
// plaintext or a zero key.
//
// AT-REST FORMAT (bytea):  version(1 byte) ‖ nonce(12) ‖ ciphertext ‖ tag(16)   — AES-256-GCM.
// `body_sha256` (the §164.312(c) integrity digest) is the SHA-256 of the PLAINTEXT computed
// PRE-encryption (the §4.4 hash-verify job decrypts and re-checks it), so it lives here too.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_LEN = 1 + NONCE_LEN + TAG_LEN; // header + tag, even with an empty ciphertext
const DEK_INFO_PREFIX = "wardenx-message-dek:"; // HKDF `info` label, org-bound

/** Load the 32-byte master KEK from MESSAGING_ENCRYPTION_KEY (base64). Fail-closed. */
export function loadMessagingKek(raw: string | undefined = process.env.MESSAGING_ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new Error("MESSAGING_ENCRYPTION_KEY is required (message body encryption — fail-closed)");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`MESSAGING_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`);
  }
  return key;
}

/** Derive a tenant's 32-byte message DEK from the master KEK + org id (HKDF-SHA256, org-bound). */
export function deriveOrgDek(kek: Buffer, orgId: string): Buffer {
  // hkdfSync returns an ArrayBuffer; wrap as a Buffer for the cipher APIs.
  const derived = hkdfSync("sha256", kek, Buffer.alloc(0), `${DEK_INFO_PREFIX}${orgId}`, KEY_LEN);
  return Buffer.from(derived);
}

/** Encrypt a plaintext body → versioned bytea envelope (random nonce per call) under the tenant DEK. */
export function sealMessageBody(plaintext: string, dek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, tag]);
}

/** Decrypt a bytea envelope. Throws on a wrong DEK, tamper (GCM auth fail), or bad format/version. */
export function openMessageBody(cipher: Buffer, dek: Buffer): string {
  if (cipher.length < MIN_LEN) throw new Error("message body-crypto: malformed ciphertext");
  if (cipher[0] !== VERSION) throw new Error(`message body-crypto: unsupported version ${cipher[0]}`);
  const nonce = cipher.subarray(1, 1 + NONCE_LEN);
  const tag = cipher.subarray(cipher.length - TAG_LEN);
  const ct = cipher.subarray(1 + NONCE_LEN, cipher.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** The §164.312(c) integrity digest — hex SHA-256 of the PLAINTEXT, computed pre-encryption. */
export function messageBodySha256(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
