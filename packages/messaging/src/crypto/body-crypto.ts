// @chartwarden/messaging · crypto — message body envelope encryption (M36 §3.4 / M36-F03, FB-T05).
//
// Per-tenant DEK envelope crypto for `message.body_cipher` (bytea). SERVER-ONLY (node:crypto) —
// the package is never bundled into the browser (the apps/web slices import @chartwarden/ui only), so
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
import { ChartWardenError } from "@chartwarden/types";

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MIN_LEN = 1 + NONCE_LEN + TAG_LEN; // header + tag, even with an empty ciphertext
// HKDF `info` label, org-bound. ChartWarden rename (release 1 = READ-SIDE): readers derive a DEK under every label
// (current first), the writer uses DEK_INFO_PREFIX_WRITE. LEGACY(wardenx->chartwarden): remove the legacy entry after
// the backfill (release 3).
const DEK_INFO_PREFIX_CURRENT = "chartwarden-message-dek:";
const DEK_INFO_PREFIX_LEGACY = "wardenx-message-dek:";
// Release 2 (write-side flip): set to DEK_INFO_PREFIX_CURRENT, then re-seal every legacy-scheme (v1) body_cipher.
const DEK_INFO_PREFIX_WRITE = DEK_INFO_PREFIX_LEGACY;
const DEK_INFO_PREFIXES_READ = [DEK_INFO_PREFIX_CURRENT, DEK_INFO_PREFIX_LEGACY] as const;

/**
 * Typed 503 code for a missing/malformed master key. It is a server misconfiguration, not a caller error, so the
 * error handler renders the standard envelope (not an untyped 500) and the web composer can say so.
 */
export const MESSAGING_KEY_UNAVAILABLE = "MESSAGING_ENCRYPTION_UNAVAILABLE";
/** Sent to clients; names no env var and no key length. The server log carries the code and stack (error-handler logs every 5xx). */
const MESSAGING_KEY_UNAVAILABLE_MESSAGE = "Message encryption is unavailable";

/** Load the 32-byte master KEK from MESSAGING_ENCRYPTION_KEY (base64). Fail-closed. */
export function loadMessagingKek(
  raw: string | undefined = process.env.MESSAGING_ENCRYPTION_KEY,
): Buffer {
  if (!raw) {
    throw new ChartWardenError(MESSAGING_KEY_UNAVAILABLE, MESSAGING_KEY_UNAVAILABLE_MESSAGE, 503);
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LEN) {
    // Generic client text: the expected length is not echoed back (no key-length oracle).
    throw new ChartWardenError(MESSAGING_KEY_UNAVAILABLE, MESSAGING_KEY_UNAVAILABLE_MESSAGE, 503);
  }
  return key;
}

/** Derive a tenant's 32-byte message DEK from the master KEK + org id (HKDF-SHA256, org-bound). */
export function deriveOrgDek(kek: Buffer, orgId: string): Buffer {
  return deriveDekFor(kek, orgId, DEK_INFO_PREFIX_WRITE);
}

function deriveDekFor(kek: Buffer, orgId: string, prefix: string): Buffer {
  // hkdfSync returns an ArrayBuffer; wrap as a Buffer for the cipher APIs.
  return Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), `${prefix}${orgId}`, KEY_LEN));
}

/** Every DEK a legacy (v1) body of this tenant may have been sealed under: current label first, then legacy. */
export function deriveOrgReadDeks(kek: Buffer, orgId: string): readonly Buffer[] {
  return DEK_INFO_PREFIXES_READ.map((prefix) => deriveDekFor(kek, orgId, prefix));
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
export function openMessageBody(cipher: Buffer, dek: Buffer | readonly Buffer[]): string {
  if (cipher.length < MIN_LEN) throw new Error("message body-crypto: malformed ciphertext");
  if (cipher[0] !== VERSION)
    throw new Error(`message body-crypto: unsupported version ${cipher[0]}`);
  const nonce = cipher.subarray(1, 1 + NONCE_LEN);
  const tag = cipher.subarray(cipher.length - TAG_LEN);
  const ct = cipher.subarray(1 + NONCE_LEN, cipher.length - TAG_LEN);
  // A list of DEKs (current, legacy label) is tried in order; the error after the last is the first key's GCM error, so
  // which label (if any) matched is not observable.
  const deks = Buffer.isBuffer(dek) ? [dek] : (dek as readonly Buffer[]);
  let firstError: unknown;
  for (const candidate of deks) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", candidate, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error("message body-crypto: no key supplied");
}

// ── RING ENVELOPE (v2) — M36 WP 2.13 / ADR-0058 P1 ──────────────────────────────────────────────────
// The tenant DEK is the M34 wrapped-DEK ring key (random 32 bytes, destroyable), NOT an HKDF derivation. The envelope
// carries the ring version that sealed it, so old and new rows coexist and a rotation keeps old rows readable:
//   version(1)=2 ‖ verLen(1) ‖ ringVersion(ascii) ‖ nonce(12) ‖ ciphertext ‖ tag(16)   — AES-256-GCM
// AAD = RING_AAD_PREFIX_WRITE + "<orgId>:<ringVersion>" ("wardenx-message-body:v2:" until the ChartWarden label flip), so a row cannot be opened under another tenant or relabelled.
// `body_sha256` is unchanged (hash of the plaintext); the scheme is therefore also the per-row marker the backfill and the
// legacy-row count read (first byte of body_cipher).
const RING_VERSION_BYTE = 2;
const RING_LABEL = /^[A-Za-z0-9._-]{1,32}$/;
// ChartWarden rename of the ring AAD label (release 1 = READ-SIDE): open accepts both (current first), seal keeps the
// legacy one. LEGACY(wardenx->chartwarden): remove the legacy entry after the backfill (release 3).
const RING_AAD_PREFIX_CURRENT = "chartwarden-message-body:v2:";
const RING_AAD_PREFIX_LEGACY = "wardenx-message-body:v2:";
// Release 2 (write-side flip): set to RING_AAD_PREFIX_CURRENT, then re-seal every v2 body_cipher (and poll labels if any).
const RING_AAD_PREFIX_WRITE = RING_AAD_PREFIX_LEGACY;
const RING_AAD_PREFIXES_READ = [RING_AAD_PREFIX_CURRENT, RING_AAD_PREFIX_LEGACY] as const;

/** A ring DEK as the M34 `TenantKeyProvider` hands it out (`TenantDek`). */
export interface RingBodyDek {
  readonly version: string;
  readonly key: Buffer;
}

export type BodyEnvelopeScheme = "legacy" | "ring" | "erased" | "unknown";

/** Classify a `body_cipher` by its leading byte, without decrypting. Empty = erased by the eraser. */
export function bodyEnvelopeScheme(cipher: Buffer): BodyEnvelopeScheme {
  if (cipher.length === 0) return "erased";
  if (cipher[0] === VERSION) return "legacy";
  if (cipher[0] === RING_VERSION_BYTE) return "ring";
  return "unknown";
}

function ringAad(prefix: string, orgId: string, version: string): Buffer {
  return Buffer.from(`${prefix}${orgId}:${version}`, "utf8");
}

/** Seal a plaintext under a tenant ring DEK → v2 envelope that records the ring version. */
export function sealMessageBodyRing(plaintext: string, dek: RingBodyDek, orgId: string): Buffer {
  if (!RING_LABEL.test(dek.version)) throw new Error("message body-crypto: bad ring version label");
  if (dek.key.length !== KEY_LEN)
    throw new Error(`message body-crypto: DEK must be ${KEY_LEN} bytes`);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek.key, nonce);
  cipher.setAAD(ringAad(RING_AAD_PREFIX_WRITE, orgId, dek.version));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const label = Buffer.from(dek.version, "ascii");
  return Buffer.concat([
    Buffer.from([RING_VERSION_BYTE, label.length]),
    label,
    nonce,
    ct,
    cipher.getAuthTag(),
  ]);
}

function parseRing(cipher: Buffer): { version: string; body: number } {
  if (cipher.length < 2 + 1 + NONCE_LEN + TAG_LEN || cipher[0] !== RING_VERSION_BYTE) {
    throw new Error("message body-crypto: malformed ring ciphertext");
  }
  const len = cipher[1] ?? 0;
  const body = 2 + len;
  if (len < 1 || cipher.length < body + NONCE_LEN + TAG_LEN) {
    throw new Error("message body-crypto: malformed ring ciphertext");
  }
  return { version: cipher.subarray(2, body).toString("ascii"), body };
}

/** The ring version recorded in a v2 envelope (which DEK version to ask the key provider for). */
export function ringEnvelopeVersion(cipher: Buffer): string {
  return parseRing(cipher).version;
}

/** Open a v2 envelope under the ring DEK of that version. Throws on a wrong key/org, tamper or bad format. */
export function openMessageBodyRing(cipher: Buffer, key: Buffer, orgId: string): string {
  const { version, body } = parseRing(cipher);
  const nonce = cipher.subarray(body, body + NONCE_LEN);
  const tag = cipher.subarray(cipher.length - TAG_LEN);
  const ct = cipher.subarray(body + NONCE_LEN, cipher.length - TAG_LEN);
  let firstError: unknown;
  for (const prefix of RING_AAD_PREFIXES_READ) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(ringAad(prefix, orgId, version));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError;
}

/** The §164.312(c) integrity digest — hex SHA-256 of the PLAINTEXT, computed pre-encryption. */
export function messageBodySha256(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
