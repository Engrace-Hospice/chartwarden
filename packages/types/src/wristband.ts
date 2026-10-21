// @chartwarden/types -- GAP-020: the patient wristband payload codec + verdict vocabulary.
//
// A wristband encodes an OPAQUE, random, per-generation token -- never an MRN, name or DOB. The shape is
//   WXB1.<26 Crockford-base32 chars = 128 random bits>.<4 hex CRC-16>      (36 ASCII chars)
// so a lost band leaks no PHI, a token cannot be guessed, and a reprint / merge / identity correction can
// void it without touching the identity. The CRC lets a scanner or client reject a MISREAD locally ("rescan")
// instead of reporting a wrong patient; the server CRC-checks first and answers `malformed`, so a damaged
// barcode is never mistaken for a wrong-patient safety event.
//
// PURE and crypto-free (leaf package; `apps/web` does not depend on `@chartwarden/shared`). The server-side digest
// (org-salted SHA-256, `node:crypto`) lives with its only user, M5.

/** The codec version carried in every payload. */
export const WRISTBAND_PAYLOAD_VERSION = "WXB1";
/** Entropy per token: 128 bits. */
export const WRISTBAND_TOKEN_BYTES = 16;
/** `WXB1` + `.` + 26 + `.` + 4 = 36 (the design said 37; that was an arithmetic slip). */
export const WRISTBAND_PAYLOAD_LENGTH = 36;

/** What M5's `PatientWristbandVerifier` concluded about one scan (the M13 arm reads only this). */
export type WristbandVerdictStatus =
  | "verified"
  | "mismatch"
  | "not_presented"
  | "not_on_file"
  | "superseded"
  | "voided"
  | "malformed";

/** Every status, in a stable order (DB CHECK / UI exhaustiveness). */
export const WRISTBAND_VERDICT_STATUSES: readonly WristbandVerdictStatus[] = [
  "verified",
  "mismatch",
  "not_presented",
  "not_on_file",
  "superseded",
  "voided",
  "malformed",
];

/** Why a generation was issued (`patient_wristband.issue_reason` CHECK mirror). The FIRST print is `first_issue`. */
export const WRISTBAND_ISSUE_REASONS = [
  "first_issue",
  "reprint_lost",
  "reprint_damaged",
  "reprint_other",
  "identity_correction",
] as const;
export type WristbandIssueReason = (typeof WRISTBAND_ISSUE_REASONS)[number];

/** Why a generation was killed outright (`patient_wristband.void_reason` CHECK mirror). */
export const WRISTBAND_VOID_REASONS = [
  "identity_error",
  "patient_merged",
  "patient_deceased",
  "compromised",
] as const;
export type WristbandVoidReason = (typeof WRISTBAND_VOID_REASONS)[number];

/** Reasons an operator may pick on the void route (the rest are system-driven by lifecycle hooks). */
export const WRISTBAND_OPERATOR_VOID_REASONS = ["identity_error", "compromised"] as const;

/**
 * How long after an OFFLINE scan a band that was active at the scan may still verify even though it has since
 * been superseded (a reprint during the shift). 72 h = the M13 late-entry ladder ceiling. A voided band never
 * gets this grace.
 */
export const OFFLINE_WRISTBAND_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAYLOAD_RE = /^WXB1\.([0-9A-HJKMNP-TV-Z]{26})\.([0-9A-F]{4})$/;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over an ASCII string, as 4 upper-case hex digits. */
export function crc16(ascii: string): string {
  let crc = 0xffff;
  for (let i = 0; i < ascii.length; i++) {
    crc ^= (ascii.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function base32Crockford(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** Render 16 random bytes as a printable payload. The caller owns the entropy (CSPRNG). */
export function formatWristbandPayload(tokenBytes: Uint8Array): string {
  if (tokenBytes.length !== WRISTBAND_TOKEN_BYTES)
    throw new RangeError(`a wristband token is exactly ${WRISTBAND_TOKEN_BYTES} bytes`);
  const body = `${WRISTBAND_PAYLOAD_VERSION}.${base32Crockford(tokenBytes)}`;
  return `${body}.${crc16(body)}`;
}

export type ParsedWristbandPayload =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "malformed" | "bad_checksum" };

/**
 * Parse a scanned / typed payload. Surrounding whitespace (keyboard-wedge CR/LF) is trimmed and a typed
 * lower-case fallback is upper-cased; anything else that is not the exact shape is `malformed`. On success
 * `token` is `WXB1.<base32>` (the checksum is a transport check, not part of the secret the digest covers).
 */
export function parseWristbandPayload(raw: string): ParsedWristbandPayload {
  const m = PAYLOAD_RE.exec(raw.trim().toUpperCase());
  if (!m) return { ok: false, reason: "malformed" };
  const token = `${WRISTBAND_PAYLOAD_VERSION}.${m[1]}`;
  if (crc16(token) !== m[2]) return { ok: false, reason: "bad_checksum" };
  return { ok: true, token };
}
