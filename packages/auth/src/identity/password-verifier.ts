// @chartwarden/auth · identity — verify a password for a known user WITHOUT minting a session (#589).
//
// The screen-lock unlock is a re-authentication of the session the user already holds. Better Auth's only public
// password check is sign-in, which creates a new session (org-less: the org binds later, in select-organization).
// This reaches the same hash check sign-in uses (`$context.password.verify` over the user's credential account),
// so the algorithm and any rehash policy stay Better Auth's, and nothing is written.
import { createHash } from "node:crypto";

/** The structural slice of a Better Auth instance the verifier needs. */
export interface PasswordVerifierCapableAuth {
  $context: Promise<{
    password: {
      verify(input: { hash: string; password: string }): Promise<boolean>;
      hash(password: string): Promise<string>;
    };
    internalAdapter: {
      findAccounts(
        userId: string,
      ): Promise<Array<{ providerId: string; password?: string | null }>>;
    };
  }>;
}

export interface PasswordVerifier {
  verify(input: { userId: string; password: string }): Promise<boolean>;
  /** False for an SSO-only / link-session account with no credential password: it can never pass `verify` (#602). */
  hasPassword(userId: string): Promise<boolean>;
}

export function createPasswordVerifier(auth: PasswordVerifierCapableAuth): PasswordVerifier {
  return {
    async hasPassword(userId) {
      const ctx = await auth.$context;
      const accounts = await ctx.internalAdapter.findAccounts(userId);
      return accounts.some((a) => a.providerId === "credential" && Boolean(a.password));
    },
    async verify({ userId, password }) {
      const ctx = await auth.$context;
      const accounts = await ctx.internalAdapter.findAccounts(userId);
      const hash = accounts.find((a) => a.providerId === "credential")?.password;
      if (!hash) {
        // Spend the same hashing time as a real check so "no password account" is not distinguishable by latency.
        await ctx.password.hash(createHash("sha256").update(userId).digest("hex"));
        return false;
      }
      return ctx.password.verify({ hash, password });
    },
  };
}
