// apps/backend/src/modules/36-messaging/endpoint-verification.ts — M36 §4.2 endpoint OTP (GAP-166).
//
// `verifyEndpoint` used to `void token` and flip any pending sms/email endpoint to `verified` for ANY
// token — so a user could "verify" a phone number or mailbox they do not own, and the (future) dispatcher
// would then send alert content to it. The check lives here as pure functions so it is unit-tested without
// a database: a random numeric code is issued at registration, only its salted SHA-256 is stored
// (`delivery_endpoint.verification_token_hash`, migration 0471), and the confirm compares in constant time
// with a TTL and an attempt cap (a 6-digit code is otherwise brute-forceable).
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** Digits in an issued verification code. */
export const VERIFICATION_CODE_LENGTH = 6;
/** A code is valid for this long after issue. */
export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong guesses allowed before the endpoint must be re-registered (a fresh code resets the count). */
export const MAX_VERIFICATION_ATTEMPTS = 5;

/** Cryptographically random, zero-padded numeric code. */
export function generateVerificationCode(): string {
  return randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)
    .toString()
    .padStart(VERIFICATION_CODE_LENGTH, "0");
}

/** Salted with the endpoint id so identical codes on two endpoints never share a hash. */
export function hashVerificationCode(endpointId: string, code: string): string {
  return createHash("sha256").update(`${endpointId}:${code}`).digest("hex");
}

export type VerificationOutcome = "ok" | "mismatch" | "expired" | "locked" | "not_issued";

export interface VerificationState {
  readonly endpointId: string;
  readonly tokenHash: string | null;
  readonly expiresAt: Date | null;
  readonly attempts: number;
}

/** Pure decision: does `submitted` confirm the endpoint at `now`? Constant-time on the hash compare. */
export function checkVerificationCode(
  state: VerificationState,
  submitted: string,
  now: Date,
): VerificationOutcome {
  if (state.tokenHash === null || state.expiresAt === null) return "not_issued";
  if (state.attempts >= MAX_VERIFICATION_ATTEMPTS) return "locked";
  if (now.getTime() > state.expiresAt.getTime()) return "expired";
  const expected = Buffer.from(state.tokenHash, "hex");
  const actual = Buffer.from(hashVerificationCode(state.endpointId, submitted), "hex");
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  return matches ? "ok" : "mismatch";
}
