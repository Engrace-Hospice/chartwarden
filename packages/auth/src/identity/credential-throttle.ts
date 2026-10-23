// @chartwarden/auth · identity — the §5.3.1 brute-force / credential-stuffing guard (AC-05).
//
// WHAT WAS MISSING. SECURITY_HARDENING §5.3.1 specifies a per-USERNAME failed-attempt limit and a
// per-IP failed-attempt limit on login. Neither existed. The only `lockout` in the codebase was
// M2's step-up ceremony (3 consecutive failures → session terminate), which is a different control
// on a different surface — it protects a re-authentication inside an ALREADY authenticated session
// and does nothing for someone guessing passwords against a named account from outside.
//
// The global SD-055 limiter (`bootstrap/plugins/security.ts`) does cover `/api/auth/*` — it is an
// `onRequest` hook with no path exemption, unlike the CSRF plugin which does exempt that prefix — so
// login was never entirely unprotected. But it is 30/min per IP counting ALL requests, not failures,
// and it is keyed only by IP: it does nothing about a slow, distributed attack against one account,
// which is exactly the credential-stuffing shape §5.3.1 names.
//
// THE KEYSPACE HOLDS NO IDENTIFIERS. The username is SHA-256'd before it becomes a key. An email is
// PII, limiter keys live in a shared Valkey deployment beside the BullMQ queues, and nothing about
// this control needs the plaintext — only equality.
//
// A NOTE ON LOCKOUT AS A DoS VECTOR. A per-username lockout lets anyone deny service to a known
// account by failing deliberately. That is why the window is FIXED and self-healing (the counter
// expires; there is no admin unlock to queue up) and why the failure count is cleared on any
// successful sign-in. NIST 800-63B §5.2.2 prefers throttling to hard lockout for this reason; the
// shape here is throttling with a floor, which satisfies §5.3.1's intent without an unlock backlog.
import { createHash } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";

/**
 * Failed-attempt counters. `recordFailure` arms the key's expiry on the FIRST failure of a window
 * (fixed window, same contract as M1's `RateLimitStore`), `failureCount` reads without incrementing
 * — the read is what lets the guard refuse BEFORE the credential is checked — and `clear` drops the
 * counter on a successful sign-in.
 */
export interface FailedLoginStore {
  recordFailure(key: string, windowMs: number): Promise<number>;
  failureCount(key: string): Promise<number>;
  clear(key: string): Promise<void>;
  /** Milliseconds left in `key`'s window, or null when it has no live window. Optional: callers fall back to the full window. */
  remainingMs?(key: string): Promise<number | null>;
}

/** §5.3.1's two budgets. Defaults are the values the spec states. */
export interface CredentialThrottlePolicy {
  /** Failed attempts against ONE username before refusing (§5.3.1: 5). */
  readonly perUsernameLimit: number;
  /** Failed attempts from ONE IP before refusing (§5.3.1: 30). */
  readonly perIpLimit: number;
  /** The window both budgets count within, in ms (§5.3.1: 10 minutes). */
  readonly windowMs: number;
}

export const CREDENTIAL_THROTTLE_POLICY: CredentialThrottlePolicy = Object.freeze({
  perUsernameLimit: 5,
  perIpLimit: 30,
  windowMs: 600_000,
});

/** The sign-in paths this guard governs, relative to the auth base path. */
const GUARDED_SUFFIXES = ["/sign-in/email", "/sign-in/username"] as const;

/** SHA-256 of the normalized username — the key material, so no address is ever stored. */
export function credentialKey(username: string): string {
  return createHash("sha256").update(username.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** Whether `path` is one of the credential-checking endpoints (vs. sign-out, callbacks, etc.). */
export function isGuardedSignInPath(path: string, basePath: string): boolean {
  const withoutQuery = path.split("?", 1)[0] ?? path;
  return GUARDED_SUFFIXES.some((s) => withoutQuery === `${basePath}${s}`);
}

/** Pull the username out of a parsed sign-in body without assuming a shape. */
export function usernameFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const field of ["email", "username"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * The verdict a credential check produced. THREE states, not two: a response that is neither a
 * successful sign-in nor a rejected credential (a malformed body, an unknown provider) must be
 * `ignored`. Folding it into either of the others is a bypass in one direction or a lockout vector
 * in the other — treating it as success would let a client clear a spent budget with one malformed
 * request, and treating it as failure would let a client lock an account out without ever
 * attempting a password.
 */
export type CredentialOutcome = "success" | "failure" | "ignored";

/** Map an auth response status onto a {@link CredentialOutcome}. */
export function outcomeOfStatus(status: number): CredentialOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 401 || status === 403) return "failure";
  return "ignored";
}

export interface CredentialThrottle {
  /** Refuse (throw) when either budget is already spent. Call BEFORE the credential is checked. */
  assertUnderBudget(input: { username: string | null; ip: string }): Promise<void>;
  /** Record the outcome of a credential check. Success clears the username's counter. */
  record(input: {
    username: string | null;
    ip: string;
    outcome: CredentialOutcome;
  }): Promise<void>;
}

/**
 * 429 rendered through the canonical error envelope (M1's error-handler), NOT a hand-rolled
 * `reply.code(429).send({error: "..."})` — that flat shape is GAP-090, and this is a new surface.
 * The `Retry-After` header is set by the caller, which owns the reply.
 */
export class CredentialThrottleError extends ChartWardenError {
  constructor(readonly retryAfterSeconds: number) {
    super("TOO_MANY_FAILED_ATTEMPTS", "too many failed sign-in attempts — try again later", 429);
    this.name = "CredentialThrottleError";
  }
}

/**
 * Build the guard over a {@link FailedLoginStore}.
 *
 * Fails OPEN on a store outage, matching every other limiter in the platform: this is a
 * defense-in-depth availability control, and a Valkey blip must not lock every user out of the
 * product. `onStoreError` is how that stays visible rather than silent.
 */
export function createCredentialThrottle(
  store: FailedLoginStore,
  opts: {
    policy?: CredentialThrottlePolicy;
    onStoreError?: (err: unknown) => void;
    /**
     * Namespace of the counters (default `login`). A second surface that wants the same §5.3.1 shape but its OWN
     * budget (portal session establishment, link redemption) passes a distinct prefix, so a stuffing run against
     * one door cannot lock the other.
     */
    keyPrefix?: string;
  } = {},
): CredentialThrottle {
  const policy = opts.policy ?? CREDENTIAL_THROTTLE_POLICY;
  const prefix = opts.keyPrefix ?? "login";
  const retryAfter = Math.ceil(policy.windowMs / 1000);
  const guard = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      opts.onStoreError?.(err);
      return fallback;
    }
  };

  return {
    async assertUnderBudget({ username, ip }) {
      const [userCount, ipCount] = await Promise.all([
        username === null
          ? Promise.resolve(0)
          : guard(() => store.failureCount(`${prefix}:user:${credentialKey(username)}`), 0),
        guard(() => store.failureCount(`${prefix}:ip:${ip}`), 0),
      ]);
      if (userCount >= policy.perUsernameLimit || ipCount >= policy.perIpLimit) {
        throw new CredentialThrottleError(retryAfter);
      }
    },

    async record({ username, ip, outcome }) {
      if (outcome === "ignored") return;
      if (outcome === "success") {
        // Clear only the USERNAME counter. The per-IP budget deliberately survives a success: one
        // valid credential in a stuffing run is exactly when an attacker would want the slate wiped.
        if (username !== null)
          await guard(() => store.clear(`${prefix}:user:${credentialKey(username)}`), undefined);
        return;
      }
      await Promise.all([
        username === null
          ? Promise.resolve(0)
          : guard(
              () =>
                store.recordFailure(`${prefix}:user:${credentialKey(username)}`, policy.windowMs),
              0,
            ),
        guard(() => store.recordFailure(`${prefix}:ip:${ip}`, policy.windowMs), 0),
      ]);
    },
  };
}

/** In-memory store — the slice/test default and a correct single-replica implementation. */
export function createInMemoryFailedLoginStore(now: () => number = Date.now): FailedLoginStore {
  const counters = new Map<string, { count: number; windowStart: number; windowMs: number }>();
  const live = (key: string) => {
    const row = counters.get(key);
    if (!row) return null;
    if (now() - row.windowStart >= row.windowMs) {
      counters.delete(key);
      return null;
    }
    return row;
  };
  return {
    async recordFailure(key, windowMs) {
      const row = live(key);
      if (!row) {
        counters.set(key, { count: 1, windowStart: now(), windowMs });
        return 1;
      }
      row.count += 1;
      return row.count;
    },
    async failureCount(key) {
      return live(key)?.count ?? 0;
    },
    async clear(key) {
      counters.delete(key);
    },
    async remainingMs(key) {
      const row = live(key);
      return row ? row.windowMs - (now() - row.windowStart) : null;
    },
  };
}
