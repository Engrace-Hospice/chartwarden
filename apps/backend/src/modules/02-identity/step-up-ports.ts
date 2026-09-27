// apps/backend/src/modules/02-identity/step-up-ports.ts — M2-T05 step-up dependency ports
// + slice in-memory adapters (M2 spec §4.4).
//
// The step-up route is wired through injected ports, matching the M1 foundation-route
// pattern (every external dependency injected with a slice-safe default; production swaps the
// real adapter). The slice has no live Postgres/Valkey/WebAuthn, so the defaults are in-memory
// — enough to prove the route contract + the §7.8–7.11 acceptance with Fastify `inject`.
//
// Production adapters (tracked follow-ups, consistent with the slice's forward-seam pattern):
//   • SessionResolver        → Better Auth session resolution (M2-T07 published seam)
//   • MfaEnrollmentReader    → SELECT on `two_factor` (enabled) / `passkey` (active), M2-owned
//   • MfaVerifier            → the WebAuthn assertion + TOTP code verifiers (existing crypto)
//   • SessionStepUpWriter    → UPDATE `session` inside withOrgContext + withOutbox
//   • StepUpChallengeStore   → Valkey (challenge TTL + lockout failure z-set)
//   • AuditExecutor          → the Drizzle tx (atomic audit, §7.3)
import type { AuditExecutor, NewAuditEvent } from "@wardenx/audit";
import type { StepUpFactor } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import type { IdentityOutboxPort } from "./identity-ports";
import type { SessionStepUpState } from "./policy/step-up-resolver";

/** A step-up-qualifying MFA factor (SMS is excluded — D9 / §4.3.1). */
export type StepUpQualifyingFactor = "webauthn" | "totp";

/** The authenticated session a step-up acts on (resolved from the request). */
export interface AuthenticatedSession extends SessionStepUpState {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
}

/** Resolves the current request's authenticated session (null ⇒ unauthenticated). */
export interface SessionResolver {
  resolve(
    request: FastifyRequest,
  ): Promise<AuthenticatedSession | null> | AuthenticatedSession | null;
}

/** Reads whether a user has a given step-up factor enrolled + active. */
export interface MfaEnrollmentReader {
  hasFactor(input: {
    userId: string;
    factor: StepUpQualifyingFactor;
  }): Promise<boolean> | boolean;
}

/** Verifies a step-up challenge response (WebAuthn assertion or TOTP code). */
export interface MfaVerifier {
  verify(input: {
    userId: string;
    factor: StepUpQualifyingFactor;
    webauthnChallenge?: string;
    assertion?: unknown;
    totpCode?: string;
  }): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
}

/** Writes step-up state (paired-write, D8) / terminates a session on lockout. */
export interface SessionStepUpWriter {
  recordStepUp(input: {
    sessionId: string;
    factor: StepUpQualifyingFactor;
    at: Date;
  }): Promise<void>;
  terminate(input: { sessionId: string; reason: string }): Promise<void>;
}

/** A pending step-up challenge held in the challenge store (Valkey in production). */
export interface StepUpChallenge {
  readonly sessionId: string;
  readonly membershipId: string;
  readonly factor: StepUpQualifyingFactor;
  readonly webauthnChallenge?: string;
  readonly createdAt: string;
}

/**
 * The challenge + lockout store. `put`/`get`/`del` hold the short-lived challenge;
 * `recordFailure`/`recentFailureCount`/`clearFailures` implement the consecutive-failure
 * lockout window (STEP_UP_POLICY.lockoutWindowSec / lockoutThreshold).
 */
export interface StepUpChallengeStore {
  put(challengeId: string, challenge: StepUpChallenge, ttlSec: number): Promise<void>;
  get(challengeId: string): Promise<StepUpChallenge | null>;
  del(challengeId: string): Promise<void>;
  recordFailure(sessionId: string): Promise<void>;
  recentFailureCount(sessionId: string): Promise<number>;
  clearFailures(sessionId: string): Promise<void>;
}

/** The full injection surface for `registerSessionStepUpRoutes`. */
export interface StepUpRouteDeps {
  sessions: SessionResolver;
  writer: SessionStepUpWriter;
  enrollment: MfaEnrollmentReader;
  verifier: MfaVerifier;
  challenges: StepUpChallengeStore;
  /** Audit sink for the `m2.session.step_up.*` events (audit() executor). */
  audit: AuditExecutor;
  /** The `m2.*` transactional-outbox publisher. Omitted → record-only, no-op. */
  outbox?: IdentityOutboxPort;
  /** WebAuthn relying-party id echoed in the initiate response; default from env. */
  webauthnRpId?: string;
  /** Challenge-id generator (injectable for deterministic tests). */
  newChallengeId?: () => string;
  /** WebAuthn challenge-bytes generator (injectable for deterministic tests). */
  newWebauthnChallenge?: () => string;
}

// --- Slice in-memory adapters ------------------------------------------------------------

/** Fixed-session resolver — returns the same session regardless of request (slice/test). */
export function createFixedSessionResolver(session: AuthenticatedSession | null): SessionResolver {
  return { resolve: () => session };
}

/** In-memory enrollment reader, seeded `{ [userId]: factor[] }`. */
export function createInMemoryMfaEnrollment(
  seed: Record<string, readonly StepUpQualifyingFactor[]> = {},
): MfaEnrollmentReader {
  return {
    hasFactor: ({ userId, factor }) => (seed[userId] ?? []).includes(factor),
  };
}

/** Verifier that accepts a WebAuthn assertion present + a fixed TOTP code; rejects otherwise. */
export function createCodeVerifier(acceptTotpCode: string): MfaVerifier {
  return {
    verify({ factor, assertion, totpCode }) {
      if (factor === "webauthn") {
        return assertion ? { ok: true } : { ok: false, reason: "webauthn_verification_failed" };
      }
      return totpCode === acceptTotpCode
        ? { ok: true }
        : { ok: false, reason: "totp_verification_failed" };
    },
  };
}

/** In-memory step-up writer exposing the recorded state for assertions. */
export function createInMemorySessionStepUpWriter(): {
  writer: SessionStepUpWriter;
  stateOf(sessionId: string): SessionStepUpState | undefined;
  isTerminated(sessionId: string): boolean;
} {
  const state = new Map<string, SessionStepUpState>();
  const terminated = new Set<string>();
  return {
    writer: {
      async recordStepUp({ sessionId, factor, at }) {
        state.set(sessionId, { lastStepUpAt: at, lastStepUpFactor: factor });
      },
      async terminate({ sessionId }) {
        terminated.add(sessionId);
      },
    },
    stateOf: (sessionId) => state.get(sessionId),
    isTerminated: (sessionId) => terminated.has(sessionId),
  };
}

/** In-memory challenge + lockout store (TTL/window honored via wall-clock ms). */
export function createInMemoryStepUpChallengeStore(): StepUpChallengeStore {
  const challenges = new Map<string, { challenge: StepUpChallenge; expiresAtMs: number }>();
  const failures = new Map<string, number[]>();
  const LOCKOUT_WINDOW_MS = 60_000; // STEP_UP_POLICY.lockoutWindowSec

  return {
    async put(challengeId, challenge, ttlSec) {
      challenges.set(challengeId, { challenge, expiresAtMs: Date.now() + ttlSec * 1000 });
    },
    async get(challengeId) {
      const hit = challenges.get(challengeId);
      if (!hit) return null;
      if (hit.expiresAtMs <= Date.now()) {
        challenges.delete(challengeId);
        return null;
      }
      return hit.challenge;
    },
    async del(challengeId) {
      challenges.delete(challengeId);
    },
    async recordFailure(sessionId) {
      const list = failures.get(sessionId) ?? [];
      list.push(Date.now());
      failures.set(sessionId, list);
    },
    async recentFailureCount(sessionId) {
      const cutoff = Date.now() - LOCKOUT_WINDOW_MS;
      const recent = (failures.get(sessionId) ?? []).filter((t) => t >= cutoff);
      failures.set(sessionId, recent);
      return recent.length;
    },
    async clearFailures(sessionId) {
      failures.delete(sessionId);
    },
  };
}

/** In-memory audit executor that collects the redacted rows audit() builds (for assertions). */
export function createInMemoryAuditExecutor(): {
  executor: AuditExecutor;
  rows: NewAuditEvent[];
} {
  const rows: NewAuditEvent[] = [];
  const executor: AuditExecutor = {
    insert: () => ({
      values: async (row: NewAuditEvent) => {
        rows.push(row);
      },
    }),
  };
  return { executor, rows };
}
