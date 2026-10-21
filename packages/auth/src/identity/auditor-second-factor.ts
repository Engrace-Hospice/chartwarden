// @wardenx/auth · identity — the second-factor primitives an external auditor's enrolment is built from
// (M2 §7.7). Lives in packages/auth because it composes the vendor's PUBLISHED primitives (`better-auth/crypto`,
// `@better-auth/utils/otp`) — the `better-auth` import boundary (manifest VENDOR_ADAPTERS).
//
// WHY NOT `auth.api.enableTwoFactor`. Better Auth's TOTP enrolment is a SIGNED-IN-USER ceremony that, for a
// user without a credential account, needs `allowPasswordless` and then re-issues the session cookie on the
// way out. An auditor's session is minted by this repo's own issuer (class-bound, window-bounded) and must not
// be re-minted by a vendor endpoint; and the vendor stores backup codes ENCRYPTED, where the auditor contract
// is "shown once, stored HASHED". So the auditor path writes the SAME `two_factor` row shape the staff path
// does — `secret_encrypted` = seal(symmetricEncrypt(secret)), the format `createTotpStepUpVerifier` already
// decrypts — and shares the vendor's generator, envelope and OTP code. Nothing here is a parallel scheme.
//
// REPLAY. A TOTP code is valid for its 30-second step (and one step either side for clock skew). The caller
// records the matched step and refuses any code whose step is not strictly newer than the last accepted one,
// so an observed code cannot be spent twice (RFC 6238 §5.2).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { isSealed, loadTwoFactorKey, open, seal } from "./two-factor-crypto";

const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SEC = 30;
/** Accept the previous, current and next step: ±30 s of clock skew. */
const TOTP_SKEW_STEPS = 1;
const TOTP_SECRET_LENGTH = 32;
const TOTP_ISSUER = "ChartWarden";

/** Recovery codes: 10 codes of 20 base-32 characters (100 bits each), shown once as XXXXX-XXXXX-XXXXX-XXXXX. */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_GROUPS = 4;
const RECOVERY_CODE_GROUP_LEN = 5;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I

export interface TotpSecretOptions {
  readonly betterAuthSecret?: string;
  readonly encryptionKey?: Buffer;
}

function betterAuthSecretOf(options: TotpSecretOptions): string {
  const secret = options.betterAuthSecret ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for auditor 2FA");
  return secret;
}

export interface NewTotpEnrolment {
  /** What `two_factor.secret_encrypted` stores: the vendor envelope, sealed with the platform KEK. */
  readonly storedSecret: string;
  /** The `otpauth://` URI for the authenticator app (QR / manual entry). */
  readonly otpauthUri: string;
  /** The base-32 secret for manual entry. */
  readonly manualEntryKey: string;
}

/** Generate a fresh TOTP secret for `accountLabel` (the auditor's email). */
export async function createTotpEnrolment(
  accountLabel: string,
  options: TotpSecretOptions = {},
): Promise<NewTotpEnrolment> {
  const secret = generateRandomString(TOTP_SECRET_LENGTH);
  const envelope = await symmetricEncrypt({ key: betterAuthSecretOf(options), data: secret });
  const key = options.encryptionKey ?? loadTwoFactorKey();
  const otp = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SEC });
  const uri = otp.url(TOTP_ISSUER, accountLabel);
  const manualEntryKey = new URL(uri).searchParams.get("secret") ?? "";
  return { storedSecret: seal(envelope, key), otpauthUri: uri, manualEntryKey };
}

export type TotpStepResult =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: string };

/** Constant-time equality over two equal-purpose strings. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Match `code` against the stored secret around `nowMs` and report WHICH step matched, so the caller can
 * enforce one-time use. Every failure returns `{ ok: false }` — an undecryptable secret is a refusal, never
 * an allow.
 */
export async function matchTotpStep(
  storedSecret: string,
  code: string,
  nowMs: number,
  options: TotpSecretOptions = {},
): Promise<TotpStepResult> {
  if (!/^[0-9]{6}$/.test(code)) return { ok: false, reason: "totp_code_malformed" };
  let secret: string;
  try {
    const key = options.encryptionKey ?? loadTwoFactorKey();
    const inner = isSealed(storedSecret) ? open(storedSecret, key) : storedSecret;
    secret = await symmetricDecrypt({ key: betterAuthSecretOf(options), data: inner });
  } catch {
    return { ok: false, reason: "totp_secret_unreadable" };
  }
  const otp = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SEC });
  const current = Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
  // Evaluate every candidate (no early exit) so timing does not reveal which step matched.
  let matched: number | null = null;
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset += 1) {
    const step = current + offset;
    if (safeEqual(await otp.hotp(step), code) && (matched === null || step > matched)) {
      matched = step;
    }
  }
  return matched === null
    ? { ok: false, reason: "totp_code_invalid" }
    : { ok: true, step: matched };
}

/** The wall-clock instant a TOTP step starts (what the replay guard stores as `last_used_at`). */
export function totpStepStart(step: number): Date {
  return new Date(step * TOTP_PERIOD_SEC * 1000);
}

/** A fresh batch of recovery codes, formatted for display: `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const groups: string[] = [];
    for (let g = 0; g < RECOVERY_CODE_GROUPS; g += 1) {
      const bytes = randomBytes(RECOVERY_CODE_GROUP_LEN);
      groups.push(
        Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join(""),
      );
    }
    codes.push(groups.join("-"));
  }
  return codes;
}

/** Canonical form of a typed recovery code: upper-case, separators and spaces removed. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The one-way digest a recovery code is stored as: HMAC-SHA256 keyed by the instance secret over the
 * normalised code. A 100-bit code is not guessable from the digest; the key means a database leak alone
 * cannot even be used to confirm a guess offline.
 */
export function hashRecoveryCode(code: string, options: TotpSecretOptions = {}): string {
  return createHmac("sha256", `auditor-recovery:${betterAuthSecretOf(options)}`)
    .update(normalizeRecoveryCode(code))
    .digest("hex");
}

/** Does `typed` correspond to the stored digest? Constant time. */
export function recoveryCodeMatches(
  typed: string,
  storedHash: string,
  options: TotpSecretOptions = {},
): boolean {
  return safeEqual(hashRecoveryCode(typed, options), storedHash);
}
