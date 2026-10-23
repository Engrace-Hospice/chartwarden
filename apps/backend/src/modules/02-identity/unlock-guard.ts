// apps/backend/src/modules/02-identity/unlock-guard.ts — the failed-password budget behind the screen-lock unlock (#589).
//
// Why this is not `createCredentialThrottle`. That guard is shaped for an UNAUTHENTICATED login door: it READS a
// failure count, lets the (slow) password hash run, and only then RECORDS the outcome. For unlock that is wrong in
// three ways, each found in review:
//   1. check-then-act: N parallel guesses all read a count under the limit, all get hashed, so one burst tries far more
//      than the budget. Here the attempt is RESERVED first, atomically (`recordFailure` is an INCR and returns the new
//      count), and refunded on success - so the budget cannot be overdrawn by concurrency.
//   2. it fails OPEN on a store outage. A hijacked-session brute force is exactly what an outage must not enable, and
//      an unlock is never the critical path (the user can still sign out and in), so this fails CLOSED (503).
//   3. it carries a per-IP bucket. Behind a proxy with no trusted-proxy config every client shares one IP, so 30
//      failures anywhere would lock unlock for every tenant. The caller here is already authenticated and the target
//      is their OWN account, so the only bucket that means anything is the user's.
//
// The key holds no identifier: the user id is SHA-256'd (same `credentialKey` as login).
//
// The budget is per USER, not per session, deliberately: it must not be dodged by minting sessions. Two consequences
// are accepted. Typos on one device share the budget with the user's other sessions. And a lockout does NOT clear the
// counter: requests already in flight when the session is revoked would otherwise reserve fresh attempts, so a parallel
// burst could get every one of its guesses hashed. The price is that the user's next session, if it screen-locks within
// the 10-minute window, is told to wait (429) - a nuisance that heals itself, against a brute force that does not.
import { type FailedLoginStore, credentialKey } from "@chartwarden/auth";
import { ChartWardenError } from "@chartwarden/types";

/** Failed unlock attempts a session gets before it is ended (mirrors step-up's discipline, but per user, 10 minutes). */
export const UNLOCK_ATTEMPT_LIMIT = 5;
export const UNLOCK_WINDOW_MS = 600_000;

export interface UnlockReservation {
  /** 1-based count of attempts in this window, including this one (past the limit when refused). */
  readonly attempt: number;
  /** False once the budget is already spent: refuse WITHOUT hashing the password. */
  readonly allowed: boolean;
  /** True for exactly the final allowed attempt - if it fails, the budget is gone and the session must end. */
  readonly last: boolean;
}

export interface UnlockGuard {
  /** Atomically take one attempt for `userId`. Throws 503 UNLOCK_UNAVAILABLE if the counter store cannot be reached. */
  reserve(userId: string): Promise<UnlockReservation>;
  /** Refund the budget after a correct password. Best effort: a store error here never fails a good unlock. */
  release(userId: string): Promise<void>;
}

export function createUnlockGuard(
  store: FailedLoginStore,
  opts: {
    limit?: number;
    windowMs?: number;
    onStoreError?: (err: unknown) => void;
  } = {},
): UnlockGuard {
  const limit = opts.limit ?? UNLOCK_ATTEMPT_LIMIT;
  const windowMs = opts.windowMs ?? UNLOCK_WINDOW_MS;
  const keyOf = (userId: string): string => `screen-unlock:user:${credentialKey(userId)}`;
  return {
    async reserve(userId) {
      let attempt: number;
      try {
        attempt = await store.recordFailure(keyOf(userId), windowMs);
      } catch (err) {
        opts.onStoreError?.(err);
        throw new ChartWardenError(
          "UNLOCK_UNAVAILABLE",
          "screen unlock is temporarily unavailable; sign out and sign in again",
          503,
        );
      }
      return { attempt, allowed: attempt <= limit, last: attempt === limit };
    },
    async release(userId) {
      try {
        await store.clear(keyOf(userId));
      } catch (err) {
        opts.onStoreError?.(err);
      }
    },
  };
}
