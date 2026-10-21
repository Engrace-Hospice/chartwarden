import { createDbPasskeyCredentialStore, createWebauthnAssertionVerifier } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import type { MfaVerifier } from "./step-up-ports";

export interface StepUpVerifierOptions {
  expectedOrigin: string;
  expectedRPID: string;

  verifyTotp(input: {
    userId: string;
    code: string;
  }): Promise<boolean>;
}

export function createProductionStepUpVerifier(
  db: DbClient,
  options: StepUpVerifierOptions,
): MfaVerifier {
  const webauthn = createWebauthnAssertionVerifier(createDbPasskeyCredentialStore(db));

  return {
    async verify({ userId, factor, webauthnChallenge, assertion, totpCode }) {
      if (factor === "webauthn") {
        if (!webauthnChallenge || !assertion) {
          return {
            ok: false,
            reason: "webauthn_verification_failed",
          };
        }

        return webauthn.verify({
          userId,
          expectedChallenge: webauthnChallenge,
          assertion,
          expectedOrigin: options.expectedOrigin,
          expectedRPID: options.expectedRPID,
        });
      }

      if (!totpCode) {
        return {
          ok: false,
          reason: "totp_verification_failed",
        };
      }

      try {
        const ok = await options.verifyTotp({
          userId,
          code: totpCode,
        });

        return ok ? { ok: true } : { ok: false, reason: "totp_verification_failed" };
      } catch {
        return {
          ok: false,
          reason: "totp_verification_failed",
        };
      }
    },
  };
}
