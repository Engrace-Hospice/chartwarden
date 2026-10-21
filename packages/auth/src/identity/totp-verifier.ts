// @chartwarden/auth · identity — TOTP step-up verifier (M2 §4.4, D9).
//
// The other half of the step-up `MfaVerifier`. `webauthn-verifier.ts` next door does the WebAuthn
// factor cryptographically; until this landed, the TOTP factor had only `createCodeVerifier` — a slice
// adapter that accepts one hard-coded string — so there was no production TOTP verification anywhere.
//
// TWO LAYERS OF ENCRYPTION SIT OVER THE SECRET, and both have to come off in order:
//   1. the repo's at-rest seal (ADR-0034): `two-factor-adapter.ts` wraps the Better Auth Drizzle adapter
//      and AES-256-GCM-seals `secret`/`backupCodes` on write with the platform KEK, because Better Auth's
//      plugin does not encrypt at rest itself. `isSealed`/`open` are that layer.
//   2. Better Auth's OWN envelope: its twoFactor plugin stores the TOTP secret `symmetricEncrypt`-ed
//      under the instance `secret` (BETTER_AUTH_SECRET) before it ever reaches the adapter.
//
// So the value in `two_factor.secret_encrypted` is seal(symmetricEncrypt(secret)). This composes the
// vendor's PUBLISHED primitives — `symmetricDecrypt` from `better-auth/crypto`, `createOTP` from
// `@better-auth/utils/otp`, the same two the plugin's own verify endpoint uses — rather than
// reimplementing either. If the vendor changes its at-rest format the decrypt THROWS and the verify
// returns `{ ok: false }`; it cannot silently start accepting.
//
// WHY NOT CALL `auth.api.verifyTOTP` INSTEAD. That endpoint answers a different question: it is the
// sign-in ceremony, so it runs `verifyTwoFactor(ctx)` over the request's cookies, opens a sign-in
// attempt-counter, and on success mints session cookies via `valid()`. A step-up acts on a session that
// ALREADY exists and must not re-issue one; and this route's own lockout (STEP_UP_POLICY, three
// consecutive failures inside the window) is a different policy from the plugin's sign-in lockout.
// Borrowing the endpoint would have meant inheriting both behaviours to get a boolean.
import { createOTP } from "@better-auth/utils/otp";
import { schema } from "@chartwarden/db";
import type { DbClient } from "@chartwarden/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { isSealed, loadTwoFactorKey, open } from "./two-factor-crypto";

/** TOTP parameters. The Better Auth twoFactor plugin's defaults, which is what enrolment used. */
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SEC = 30;

/** One user's stored TOTP enrolment, exactly as the column holds it (still double-encrypted). */
export interface StoredTotpEnrolment {
  /** `two_factor.secret_encrypted` verbatim — sealed, and Better-Auth-encrypted inside that. */
  readonly secretEncrypted: string;
}

/** Reads a user's TOTP enrolment. Injected so the crypto stays testable without a database. */
export interface TotpEnrolmentStore {
  findEnrolment(userId: string): Promise<StoredTotpEnrolment | null> | StoredTotpEnrolment | null;
}

/** The verdict, matching the `MfaVerifier` contract's shape. */
export interface TotpVerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface TotpVerifier {
  verify(input: { userId: string; totpCode: string }): Promise<TotpVerifyResult>;
}

export interface TotpVerifierOptions {
  /** The Better Auth instance secret its `symmetricEncrypt` used. Defaults to `BETTER_AUTH_SECRET`. */
  readonly betterAuthSecret?: string;
  /** The platform KEK for the ADR-0034 at-rest seal. Defaults to `TWO_FACTOR_ENCRYPTION_KEY`. */
  readonly encryptionKey?: Buffer;
}

/**
 * Build the production TOTP step-up verifier.
 *
 * EVERY failure path returns `{ ok: false }` with a category rather than throwing: a thrown error here
 * would surface as a 500, and the step-up route's contract turns a false into the 401 + failure-count
 * the lockout policy is built on. A missing enrolment, an undecryptable secret and a wrong code are all
 * refusals — they differ only in the `reason` recorded on the audit row.
 */
export function createTotpStepUpVerifier(
  store: TotpEnrolmentStore,
  options: TotpVerifierOptions = {},
): TotpVerifier {
  return {
    async verify({ userId, totpCode }): Promise<TotpVerifyResult> {
      if (!/^[0-9]{6}$/.test(totpCode)) return { ok: false, reason: "totp_code_malformed" };

      const enrolment = await store.findEnrolment(userId);
      if (!enrolment) return { ok: false, reason: "totp_not_enrolled" };

      let secret: string;
      try {
        // Layer 1 — the repo's at-rest seal. `isSealed` so a row written before ADR-0034 (or by a
        // deployment with the decorator disabled) is still readable rather than mistaken for corrupt.
        const key = options.encryptionKey ?? loadTwoFactorKey();
        const inner = isSealed(enrolment.secretEncrypted)
          ? open(enrolment.secretEncrypted, key)
          : enrolment.secretEncrypted;
        // Layer 2 — Better Auth's own envelope.
        const betterAuthSecret = options.betterAuthSecret ?? process.env.BETTER_AUTH_SECRET;
        if (!betterAuthSecret) return { ok: false, reason: "totp_secret_unreadable" };
        secret = await symmetricDecrypt({ key: betterAuthSecret, data: inner });
      } catch {
        // Undecryptable is a REFUSAL, never an allow. This is the branch that fires if the vendor's
        // at-rest format changes under us, which is exactly when failing closed matters.
        return { ok: false, reason: "totp_secret_unreadable" };
      }

      const ok = await createOTP(secret, {
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD_SEC,
      }).verify(totpCode);
      return ok ? { ok: true } : { ok: false, reason: "totp_code_invalid" };
    },
  };
}

/**
 * The Drizzle store over the M1-owned `two_factor` table.
 *
 * Reads the column DIRECTLY rather than through the encrypting Better Auth adapter, so the seal is
 * still on when it arrives — the verifier above owns both unwrapping steps, which keeps the whole
 * decrypt chain in one readable place instead of half here and half in an adapter decorator.
 */
export function createDbTotpEnrolmentStore(db: DbClient): TotpEnrolmentStore {
  return {
    async findEnrolment(userId: string): Promise<StoredTotpEnrolment | null> {
      const rows = await db
        .select({ secretEncrypted: schema.twoFactor.secretEncrypted })
        .from(schema.twoFactor)
        .where(eq(schema.twoFactor.userId, userId))
        .limit(1);
      const row = rows[0];
      return row ? { secretEncrypted: row.secretEncrypted } : null;
    },
  };
}
