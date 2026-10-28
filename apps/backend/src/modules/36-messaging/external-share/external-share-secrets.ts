// M36 WP 6.6 (ADR-0096, PROPOSED) - the secrets of an external partner share: the one-time invite token, the partner's session token and the
// 8-digit second-factor code. Only hashes are stored. Tokens are 256-bit random (sha256 is enough: no brute force is possible); the code is
// low-entropy, so it is scrypt-hashed with a per-share salt AND its attempts are capped in the database (5, never reset).
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { EXTERNAL_PARTNER_NOTIFICATION_TEXT } from "@chartwarden/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 random bytes as base64url: exactly 43 characters. */
export const PARTNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^\d{8}$/;
const SCRYPT_KEYLEN = 32;

export function newPartnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPartnerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Eight digits, uniformly (crypto.randomInt), leading zeros kept. */
export function newVerificationCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

/**
 * The scrypt input: the code itself, or (ADR-0099 D3) its HMAC under a per-deployment pepper kept OUTSIDE the database, so a stolen row alone cannot be
 * brute-forced offline. No pepper = the original behaviour, unchanged.
 */
const keyed = (code: string, pepper: string | undefined): string =>
  pepper ? createHmac("sha256", pepper).update(code, "utf8").digest("hex") : code;

/** `salt:hash`, both hex. */
export function hashVerificationCode(code: string, pepper?: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(keyed(code, pepper), salt, SCRYPT_KEYLEN).toString("hex")}`;
}

/** Constant-time. A malformed code or stored value is simply "no match". */
export function verifyVerificationCode(code: string, stored: string, pepper?: string): boolean {
  if (!CODE_RE.test(code)) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(keyed(code, pepper), Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

/** The partner's bearer value: `<organizationId>.<token>`. The org picks the RLS scope; the token is looked up by hash within it. */
export function formatSessionToken(organizationId: string, token: string): string {
  return `${organizationId}.${token}`;
}

export function parseSessionToken(
  value: string,
): { readonly organizationId: string; readonly token: string } | null {
  const dot = value.indexOf(".");
  if (dot !== 36) return null;
  const organizationId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!UUID_RE.test(organizationId) || !PARTNER_TOKEN_RE.test(token)) return null;
  return { organizationId, token };
}

/**
 * ADR-0096 D9: the only text any partner notification may carry. It takes NO argument, so no message, channel, patient or partner name can
 * reach it. No sender is wired in this slice; a future one must use this and nothing else.
 */
export function partnerNotificationText(): string {
  return EXTERNAL_PARTNER_NOTIFICATION_TEXT;
}
