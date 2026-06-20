// @wardenx/auth · identity — 2FA secret at-rest encryption (M2, ADR-0034 §2).
//
// Pure AES-256-GCM seal/open for the TOTP secret + backup codes. SERVER-ONLY (node:crypto) — never
// bundled into the browser (the "./client" export does not import this). The encrypting Better Auth
// adapter decorator (a follow-up task) calls seal()/open() over M1's two_factor.*_encrypted columns.
//
// At-rest format (base64):  version(1 byte) ‖ nonce(12) ‖ ciphertext ‖ tag(16)
// Key: a single USER-LEVEL 32-byte key from TWO_FACTOR_ENCRYPTION_KEY (2FA is user-scoped, so an
// org-DEK is the wrong boundary). Fail-closed when absent/malformed.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_LEN = 1 + NONCE_LEN + TAG_LEN; // header + tag, even with empty ciphertext

/** Load the 32-byte AES key from TWO_FACTOR_ENCRYPTION_KEY (base64). Fail-closed. */
export function loadTwoFactorKey(raw: string | undefined = process.env.TWO_FACTOR_ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY is required (2FA secret encryption — fail-closed)");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(`TWO_FACTOR_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`);
  }
  return key;
}

/** Encrypt plaintext → versioned, base64 at-rest token (random nonce per call). */
export function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, tag]).toString("base64");
}

/** Decrypt an at-rest token. Throws on a wrong key, tamper (GCM auth fail), or bad format/version. */
export function open(sealed: string, key: Buffer): string {
  const buf = Buffer.from(sealed, "base64");
  if (buf.length < MIN_LEN) throw new Error("two-factor-crypto: malformed ciphertext");
  if (buf[0] !== VERSION) throw new Error(`two-factor-crypto: unsupported version ${buf[0]}`);
  const nonce = buf.subarray(1, 1 + NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Whether a stored value is one of our sealed tokens (vNN header) — used by the decorator on read. */
export function isSealed(value: string): boolean {
  try {
    const buf = Buffer.from(value, "base64");
    return buf.length >= MIN_LEN && buf[0] === VERSION && timingSafeEqual(buf.subarray(0, 1), Buffer.from([VERSION]));
  } catch {
    return false;
  }
}
