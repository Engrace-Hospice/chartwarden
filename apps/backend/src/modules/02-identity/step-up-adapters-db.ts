import {
  createDbPasskeyCredentialStore,
  createDbTotpEnrolmentStore,
  createTotpStepUpVerifier,
  createWebauthnAssertionVerifier,
  resolvePasskeyOrigins,
  resolvePasskeyRpId,
} from "@wardenx/auth";
// apps/backend/src/modules/02-identity/step-up-adapters-db.ts — M2 §4.4, the PRODUCTION step-up
// adapters. Until these landed, `registerSessionStepUpRoutes` had in-memory adapters and one caller:
// its own test.
//
// WHAT THAT MEANT. `session.last_step_up_at` was written by NOTHING in production. The step-up route
// was never mounted, and `onLoginMfaCompleted` — the other writer — is exported and called by nobody
// either. So `stepUpFreshFor` resolved a column that no code path populates, and every step-up gate in
// the platform answered "not fresh" for every caller, forever. That is the F-029 shape one layer down:
// the attribute was fixed so the fact reaches the readers, and the fact itself was never produced.
//
// It failed CLOSED, so it was never exposure. What it was is fifteen modules' worth of re-authentication
// ceremony that could not be performed — including the four write paths (M23 claim submit/replace/void,
// M27 cost-report submit, M37 IRC cap override + restraint apply) whose guard PASSES and whose domain
// then refuses on the flag.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type {
  AuthenticatedSession,
  MfaEnrollmentReader,
  MfaVerifier,
  SessionResolver,
  SessionStepUpWriter,
} from "./step-up-ports";

/**
 * Resolve the step-up subject from `request.context` — the bag the authenticate hook fills from the
 * real session row — or null.
 *
 * Every field is server-assembled: `sessionId` and `membershipId` ride on `context.attributes` (both
 * declared producers in the F-030 registry), the org and user on the context proper. Nothing here is
 * reachable from the request body, so a caller cannot step up SOMEONE ELSE'S session.
 *
 * `lastStepUpAt`/`lastStepUpFactor` are reported as null rather than read back. The routes only ever
 * WRITE them, and reading a stale pair here would invite a caller to reason about freshness from the
 * step-up route's own response instead of from M3's predicate, which is the one place that decides it.
 */
export function createContextSessionResolver(): SessionResolver {
  return {
    resolve(request: FastifyRequest): AuthenticatedSession | null {
      const ctx = request.context;
      const sessionId = ctx?.attributes?.sessionId;
      const membershipId = ctx?.attributes?.membershipId;
      if (!ctx?.userId || typeof sessionId !== "string" || sessionId.length === 0) return null;
      if (!ctx.organizationId || typeof membershipId !== "string" || membershipId.length === 0) {
        // A pre-org session has no membership to attribute the step-up to, and step-up freshness is
        // org-scoped through the seam. Null here becomes the route's 401, which is the honest answer:
        // there is nothing to step up INTO yet.
        return null;
      }
      return {
        sessionId,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        membershipId,
        lastStepUpAt: null,
        lastStepUpFactor: null,
      };
    },
  };
}

/**
 * Resolve the step-up subject straight off the `session` row rather than `request.context`. Used by
 * the alternate DB-only mount path (no context-derived membership needed): the caller passes a bare
 * `userId`/`organizationId`/`sessionId`/`membershipId` and this reads the row's persisted
 * `lastStepUpAt`/`lastStepUpFactor` back, rather than reporting them null.
 */
export function createDbStepUpSessionResolver(db: DbClient): SessionResolver {
  return {
    async resolve(request) {
      const userId = request.context.userId;
      const organizationId = request.context.organizationId;
      const sessionId = request.context.attributes?.sessionId;
      const membershipId = request.context.attributes?.membershipId;

      if (
        !userId ||
        !organizationId ||
        typeof sessionId !== "string" ||
        typeof membershipId !== "string"
      ) {
        return null;
      }

      const [session] = await db
        .select({
          lastStepUpAt: schema.sessions.lastStepUpAt,
          lastStepUpFactor: schema.sessions.lastStepUpFactor,
        })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
        .limit(1);

      if (!session) return null;

      return {
        sessionId,
        userId,
        organizationId,
        membershipId,
        lastStepUpAt: session.lastStepUpAt,
        lastStepUpFactor: session.lastStepUpFactor,
      };
    },
  };
}

/**
 * The paired-write (D8) over the M1-owned `session` row, plus lockout termination.
 *
 * Both columns move together or neither does — that is what "paired write" means here, and it is why
 * `session_step_up_paired_write` exists as a CHECK: a row carrying a timestamp with no factor (or the
 * reverse) cannot be evaluated by `stepUpFreshFor`, which needs both to decide whether the factor
 * QUALIFIES under the org's policy.
 */
export function createDbSessionStepUpWriter(db: DbClient): SessionStepUpWriter {
  return {
    async recordStepUp({ sessionId, factor, at }) {
      await db
        .update(schema.sessions)
        .set({ lastStepUpAt: at, lastStepUpFactor: factor, updatedAt: at })
        .where(eq(schema.sessions.id, sessionId));
    },
    async terminate({ sessionId }) {
      // Deleted, not flagged. The lockout's purpose is that the session stops being usable
      // immediately; leaving the row with a marker would need every reader to remember to check it.
      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    },
  };
}

/**
 * The second factor the session proved at sign-in (`last_step_up_factor`), or null for a password-only session or
 * an unknown id. The MFA matrix gate reads this: enrolment is not assurance (GAP-003/005).
 */
export function createDbSessionProofReader(
  db: DbClient,
): (sessionId: string) => Promise<string | null> {
  return async (sessionId) => {
    const [row] = await db
      .select({ factor: schema.sessions.lastStepUpFactor })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    return row?.factor ?? null;
  };
}

/**
 * Whether the user has the factor enrolled AND usable.
 *
 * `two_factor.verified` matters: Better Auth writes the row at the START of TOTP enrolment, before the
 * user has proved they can produce a code from it. Treating an unverified row as enrolled would offer a
 * TOTP challenge against a secret the user may never have scanned — a step-up they cannot complete,
 * three failures away from the lockout that terminates their session.
 */
export function createDbMfaEnrollmentReader(db: DbClient): MfaEnrollmentReader {
  return {
    async hasFactor({ userId, factor }): Promise<boolean> {
      if (factor === "totp") {
        const rows = await db
          .select({ id: schema.twoFactor.id })
          .from(schema.twoFactor)
          .where(and(eq(schema.twoFactor.userId, userId), eq(schema.twoFactor.verified, true)))
          .limit(1);
        return rows.length > 0;
      }
      const rows = await db
        .select({ id: schema.passkey.id })
        .from(schema.passkey)
        .where(and(eq(schema.passkey.userId, userId), isNotNull(schema.passkey.publicKey)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * The production `MfaVerifier`: dispatch by factor to the two real verifiers.
 *
 * SMS never reaches here — the route refuses it at the boundary (W-M2-11 / D9) and `STEP_UP_POLICY`
 * declares only WebAuthn and TOTP qualifying. An unknown factor is a refusal rather than a throw, for
 * the same reason every branch inside the two verifiers is: a throw becomes a 500, and the route's
 * contract turns a false into the 401 the lockout counter is built on.
 */
export function createDbMfaVerifier(db: DbClient): MfaVerifier {
  const webauthn = createWebauthnAssertionVerifier(createDbPasskeyCredentialStore(db));
  const totp = createTotpStepUpVerifier(createDbTotpEnrolmentStore(db));
  return {
    async verify({ userId, factor, webauthnChallenge, assertion, totpCode }) {
      if (factor === "totp") {
        if (!totpCode) return { ok: false, reason: "totp_code_missing" };
        return totp.verify({ userId, totpCode });
      }
      if (factor === "webauthn") {
        if (!assertion || !webauthnChallenge) {
          return { ok: false, reason: "webauthn_assertion_missing" };
        }
        // The SAME rp id and origin passkeys are enrolled under. @simplewebauthn compares the
        // asserted RP-id hash against the expected one, so resolving these independently here would
        // refuse every passkey this instance issued — reported as "assertion invalid", which reads as
        // an attack rather than as the misconfiguration it would be.
        return webauthn.verify({
          userId,
          expectedChallenge: webauthnChallenge,
          assertion,
          expectedOrigin: resolvePasskeyOrigins(),
          expectedRPID: resolvePasskeyRpId(),
        });
      }
      return { ok: false, reason: "factor_not_step_up_qualifying" };
    },
  };
}
