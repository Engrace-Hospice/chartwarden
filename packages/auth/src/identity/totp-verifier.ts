import { createOTP } from "@better-auth/utils/otp";
import { type DbClient, schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";

export interface TotpVerifyInput {
  readonly userId: string;
  readonly code: string;
}

export interface TotpVerifier {
  verify(input: TotpVerifyInput): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Production TOTP verifier for session step-up.
 *
 * The Better Auth /two-factor/verify-totp endpoint is deliberately NOT reused
 * here because that endpoint owns the login/2FA session flow. Step-up already
 * has an authenticated WardenX session and only needs to prove possession of
 * the enrolled TOTP factor.
 *
 * `schema.twoFactor.secretEncrypted` is expected to be plaintext at this
 * boundary only if the DB access path applies WardenX's two-factor encryption
 * decorator. Direct Drizzle access does NOT do that, so callers should inject
 * a secret reader that decrypts the stored WardenX envelope.
 */
export function createTotpVerifier(
  readSecret: (userId: string) => Promise<string | null>,
): TotpVerifier {
  return {
    async verify({ userId, code }) {
      if (!/^\d{6}$/.test(code)) {
        return { ok: false, reason: "invalid_totp" };
      }

      const secret = await readSecret(userId);
      if (!secret) {
        return { ok: false, reason: "totp_not_enrolled" };
      }

      try {
        const ok = await createOTP(secret, {
          digits: 6,
          period: 30,
        }).verify(code);

        return ok
          ? { ok: true }
          : { ok: false, reason: "invalid_totp" };
      } catch {
        return { ok: false, reason: "totp_verification_failed" };
      }
    },
  };
}

/**
 * Reads the verified TOTP enrollment row.
 *
 * IMPORTANT: this returns the stored encrypted value. Decryption belongs in
 * the composition layer using WardenX's two-factor encryption key.
 */
export function createDbTotpSecretReader(db: DbClient) {
  return async (userId: string): Promise<string | null> => {
    const [row] = await db
      .select({
        secret: schema.twoFactor.secretEncrypted,
      })
      .from(schema.twoFactor)
      .where(
        and(
          eq(schema.twoFactor.userId, userId),
          eq(schema.twoFactor.method, "totp"),
          eq(schema.twoFactor.verified, true),
        ),
      )
      .limit(1);

    return row?.secret ?? null;
  };
}