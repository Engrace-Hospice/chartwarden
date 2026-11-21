// apps/web/src/modules/02-identity — pure helpers for the authenticator-app setup screen (security-authenticator.tsx).
// Nothing here touches the network or the DOM, so it is unit-tested directly. The setup URI carries the shared secret: these
// functions return it to the caller and keep no copy.

/** An authenticator app shows six digits. */
export const TOTP_CODE_LENGTH = 6;

const OTPAUTH_TOTP = /^otpauth:\/\/totp\//i;
const BASE32 = /^[A-Z2-7]+$/;

export interface TotpSetup {
  /** The validated `otpauth://totp/…` URI, safe to use as a link on the same device. */
  readonly otpauthUri: string;
  /** The shared secret, base32, upper case, no padding: what a user types into an app that cannot scan. */
  readonly setupKey: string;
}

/**
 * Reads Better Auth's `totpURI`. Null unless it is an `otpauth://totp/` URI with a base32 secret: the screen never builds a link or a
 * setup key out of anything else (a `javascript:` or `https:` string from a broken server must not become an `href`).
 */
export function parseTotpUri(uri: string): TotpSetup | null {
  if (!OTPAUTH_TOTP.test(uri)) return null;
  let secret: string | null;
  try {
    secret = new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
  const key = secret?.replace(/\s/g, "").toUpperCase().replace(/=+$/, "");
  if (!key || !BASE32.test(key)) return null;
  return { otpauthUri: uri, setupKey: key };
}

/** The setup key in blocks of four (`ABCD EFGH …`) so it can be copied by eye without losing the place. */
export function groupSetupKey(setupKey: string): string {
  return setupKey.match(/.{1,4}/g)?.join(" ") ?? setupKey;
}

/** A code as typed or pasted (`123 456`, `123-456`) reduced to what the server expects. */
export function normaliseCode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

export function isCompleteCode(raw: string): boolean {
  return new RegExp(`^\\d{${TOTP_CODE_LENGTH}}$`).test(normaliseCode(raw));
}

export type EnrolFailure =
  | "wrong-password"
  | "wrong-code"
  | "too-many-attempts"
  | "already-on"
  | "needs-sign-in"
  | "failed";

/**
 * Sorts a Better Auth error by its stable `code`. The message is never read: it is for logs, and showing it would put server wording
 * on the screen. Every code the screen does not know is a plain failure.
 */
export function enrolFailure(
  error:
    | {
        readonly code?: string;
        readonly message?: string;
        readonly error?: { readonly code?: string };
      }
    | null
    | undefined,
): EnrolFailure {
  // ChartWarden's own refusal (the auth bridge guard) uses the standard envelope; Better Auth's errors carry the code at the top.
  if (error?.error?.code === "MFA_VERIFICATION_REQUIRED") return "needs-sign-in";
  const code = error?.code;
  if (code === "INVALID_PASSWORD") return "wrong-password";
  if (code === "INVALID_CODE") return "wrong-code";
  if (code?.startsWith("TOO_MANY_ATTEMPTS")) return "too-many-attempts";
  if (code === "TOTP_ALREADY_ENABLED") return "already-on";
  return "failed";
}

export const ENROL_FAILURE_COPY: Readonly<Record<EnrolFailure, string>> = {
  "wrong-password": "That password is not correct.",
  "wrong-code":
    "That code is not right. Check the 6-digit code in your authenticator app and try again.",
  "too-many-attempts": "Too many attempts. Wait a few minutes, then start again.",
  "already-on": "The authenticator app is already on for this account.",
  "needs-sign-in":
    "Sign in again with your passkey first. An account that already has a passkey needs it to add an authenticator app.",
  failed: "Something went wrong and nothing was turned on. Try again.",
};

/**
 * The generic failure while the code is being confirmed: the request may have reached the server (a lost response), so "nothing was
 * turned on" could be false. Retrying the same code is safe and still shows the backup codes; a reload would discard them, so it is
 * only the last resort.
 */
export const CONFIRM_FAILED_COPY =
  "Something went wrong. Try again. If it keeps happening, reload this page to see whether the authenticator app is on.";
