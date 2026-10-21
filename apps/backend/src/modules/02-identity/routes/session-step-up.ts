// apps/backend/src/modules/02-identity/routes/session-step-up.ts — M2-T05 step-up route
// (M2 spec §4.4; W-M2-09, W-M2-11; lockout per the §statechart).
//
//   POST /api/v1/sessions/step-up/initiate  — start an MFA challenge (WebAuthn or TOTP)
//   POST /api/v1/sessions/step-up           — verify it; on success write the session's
//                                             lastStepUpAt/lastStepUpFactor (paired-write, D8)
//
// Both routes sit BEHIND the Authorization Contract's `requireSession` guard (real as of
// M3-T10 — @wardenx/auth, fails closed) and then resolve the concrete authenticated session
// via M2's injected SessionResolver. SMS is refused at the route boundary (W-M2-11 / D9): `STEP_UP_POLICY`
// declares only WebAuthn + TOTP qualify. Three consecutive failures inside the lockout window
// terminate the session (423). Every state change is audited at `compliance` retention through
// the mandated audit() helper (the field denylist runs there) — never a direct insert.
//
// Step-up acts on SESSION metadata, not PHI, so the three-column / RLS / eraser PHI mandates
// do not apply here; the org-scoped audit + the context guard are the controls.
import type { AuditContext, AuditExecutor } from "@wardenx/audit";
import { requireSession, resolvePasskeyRpId } from "@wardenx/auth";
import { STEP_UP_POLICY, UnauthorizedError, ValidationError, ChartWardenError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  auditStepUpCompleted,
  auditStepUpFailed,
  auditStepUpLockout,
} from "../audit/step-up-audit";
import {
  type SessionStepUpState,
  stepUpSatisfies,
  tightenStepUpPolicy,
} from "../policy/step-up-resolver";
import type {
  AuthenticatedSession,
  StepUpChallenge,
  StepUpQualifyingFactor,
  StepUpRouteDeps,
} from "../step-up-ports";

const STEP_UP_TTL_SEC = 60; // challenge freshness window (§4.4.1)
const QUALIFYING: readonly StepUpQualifyingFactor[] = ["webauthn", "totp"];

/** Build the audit context for a step-up event from the request + resolved session. */
function auditContextFor(request: FastifyRequest, session: AuthenticatedSession): AuditContext {
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    actorKind: "user",
    correlationId: request.context.correlationId,
    requestId: String(request.id),
    sourceIp: request.context.ip,
    userAgent: request.context.userAgent,
  };
}

/** Resolve the authenticated session or fail closed (401 envelope). */
async function resolveSessionOrThrow(
  deps: StepUpRouteDeps,
  request: FastifyRequest,
): Promise<AuthenticatedSession> {
  await requireSession()(request); // Authorization Contract session gate (M3-T10) — fails closed
  const session = await deps.sessions.resolve(request);
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Read `factor` from a request body. SMS is refused with the spec's flat domain error +
 * 400 (W-M2-11 route-logic layer); anything not in the qualifying set is a 422 schema
 * violation (the validation layer). SMS is a 400 domain error (enveloped).
 */
function readFactor(body: unknown): StepUpQualifyingFactor {
  const factor = (body as { factor?: unknown } | null)?.factor;
  if (factor === "sms") {
    throw new ChartWardenError(
      "SMS_NOT_STEP_UP_QUALIFYING",
      "sms is not a step-up qualifying factor",
      400,
    );
  }
  if (factor !== "webauthn" && factor !== "totp") {
    throw new ValidationError("invalid step-up factor", [
      {
        field: "factor",
        code: "INVALID",
        message: `factor must be one of ${QUALIFYING.join(", ")}`,
      },
    ]);
  }
  return factor;
}

/**
 * The RP id this route ADVERTISES to the browser — and it must be the one enrolment used (F-081).
 *
 * This used to read its own env var, `WEBAUTHN_RP_ID`, while the verifier behind it resolves
 * `PASSKEY_RP_ID` (`step-up-adapters-db.ts`, whose comment already says the two must be identical).
 * Two variables for one fact, both REQUIRED in production, with nothing comparing them: set them
 * differently and the browser runs the ceremony under one RP id while the server checks the asserted
 * RP-id hash against the other, so every passkey the deployment ever issued is refused — reported as
 * `webauthn_verification_failed`, which reads as an attack rather than as the typo it is. Dev never
 * showed it because both fall back to "localhost".
 *
 * `PASSKEY_RP_ID` wins because it is the one the CREDENTIAL is bound to: an RP id is chosen at
 * registration and baked into the key, so the verifier has no freedom and neither does this.
 * `WEBAUTHN_RP_ID` stays a required production var (`bootstrap/env.ts`) and is now read by nothing —
 * retiring it is a deployment-config change, not a code one, and doing it here would silently relax a
 * production boot check while this PR is about the opposite.
 */
/**
 * A fresh WebAuthn challenge, BASE64URL-encoded (F-081).
 *
 * It used to be `crypto.randomUUID().replace(/-/g, "")` — a 32-character hex string — and the browser
 * then fed those 32 ASCII characters to `navigator.credentials.get` as the challenge BYTES. The
 * authenticator echoes the challenge back inside `clientDataJSON` as base64url of the bytes it was
 * given, and @simplewebauthn compares that string to `expectedChallenge` verbatim. So the server
 * compared `163779f8…` against `MTYzNzc5Zjg…` and every assertion this platform could ever produce was
 * rejected as `webauthn_verification_failed` — a real passkey, correctly signed, reported as a forgery.
 *
 * Base64url of 32 random bytes is the shape the rest of the stack already speaks: it is what Better
 * Auth's own `/passkey/generate-register-options` returns, and it round-trips through the ceremony
 * unchanged, so `expectedChallenge` is exactly the string that was issued. `crypto.getRandomValues` and
 * not `randomBytes` so this stays runtime-agnostic (the routes are Web-Crypto-only elsewhere).
 */
function defaultWebauthnChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `none` = never stepped up; `fresh` = inside the platform floor's window; `expired` = stepped up, too long ago. */
export type StepUpStatus = "none" | "fresh" | "expired";

/**
 * GAP-115 — what `GET /api/v1/me/session` reports about step-up, measured against the PLATFORM FLOOR
 * (`STEP_UP_POLICY`). A tenant may have tightened a specific operation, so `fresh` here is "fresh enough for
 * the loosest gate"; the 403 `STEP_UP_REQUIRED` stays the authority. The client uses it to open the step-up
 * modal before the gated action fires instead of after the 403 round trip (M2 D8).
 */
export function describeStepUp(
  state: SessionStepUpState,
  now: Date,
): { stepUpStatus: StepUpStatus; stepUpExpiresAt: string | null; stepUpSecondsRemaining: number } {
  if (!state.lastStepUpAt || !state.lastStepUpFactor)
    return { stepUpStatus: "none", stepUpExpiresAt: null, stepUpSecondsRemaining: 0 };
  const policy = tightenStepUpPolicy(null);
  const expiresAtMs = state.lastStepUpAt.getTime() + policy.maxAgeSec * 1000;
  const fresh = stepUpSatisfies(policy, state, now).allow;
  return {
    stepUpStatus: fresh ? "fresh" : "expired",
    stepUpExpiresAt: new Date(expiresAtMs).toISOString(),
    stepUpSecondsRemaining: fresh
      ? Math.max(0, Math.ceil((expiresAtMs - now.getTime()) / 1000))
      : 0,
  };
}

export function registerSessionStepUpRoutes(app: FastifyInstance, deps: StepUpRouteDeps): void {
  // --- GAP-115 (M2 §4.1, D8) — the read-only view of the session's step-up state ---------------
  app.get("/api/v1/me/session", async (request) => {
    await requireSession()(request); // Authorization Contract session gate — fails closed
    const session = await (deps.meSessions ?? deps.sessions).resolve(request);
    if (!session) throw new UnauthorizedError();
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      organizationId: session.organizationId,
      lastStepUpAt: session.lastStepUpAt ? session.lastStepUpAt.toISOString() : null,
      lastStepUpFactor: session.lastStepUpFactor,
      ...describeStepUp(session, (deps.now ?? (() => new Date()))()),
    };
  });

  const newChallengeId = deps.newChallengeId ?? (() => crypto.randomUUID());
  const newWebauthnChallenge = deps.newWebauthnChallenge ?? defaultWebauthnChallenge;
  const rpId = deps.webauthnRpId ?? resolvePasskeyRpId();

  // --- Initiate a step-up challenge --------------------------------------------------------
  app.post("/api/v1/sessions/step-up/initiate", async (request, reply) => {
    const session = await resolveSessionOrThrow(deps, request);
    const factor = readFactor(request.body);

    const enrolled = await deps.enrollment.hasFactor({ userId: session.userId, factor });
    if (!enrolled) {
      throw new ChartWardenError(
        factor === "webauthn" ? "WEBAUTHN_NOT_ENROLLED" : "TOTP_NOT_ENROLLED",
        `${factor} is not enrolled`,
        400,
      );
    }

    const challengeId = newChallengeId();
    const webauthnChallenge = factor === "webauthn" ? newWebauthnChallenge() : undefined;
    const challenge: StepUpChallenge = {
      sessionId: session.sessionId,
      membershipId: session.membershipId,
      factor,
      webauthnChallenge,
      createdAt: new Date().toISOString(),
    };
    await deps.challenges.put(challengeId, challenge, STEP_UP_TTL_SEC);

    return reply
      .code(200)
      .send(
        factor === "webauthn"
          ? { challengeId, factor, webauthnChallenge: { challenge: webauthnChallenge, rpId } }
          : { challengeId, factor },
      );
  });

  // --- Verify a step-up challenge ----------------------------------------------------------
  app.post("/api/v1/sessions/step-up", async (request, reply) => {
    const session = await resolveSessionOrThrow(deps, request);
    const factor = readFactor(request.body);

    const body = (request.body ?? {}) as {
      challengeId?: unknown;
      assertion?: unknown;
      totpCode?: unknown;
    };
    if (typeof body.challengeId !== "string" || body.challengeId.length === 0) {
      throw new ValidationError("invalid step-up verification", [
        { field: "challengeId", code: "REQUIRED", message: "challengeId is required" },
      ]);
    }

    const challenge = await deps.challenges.get(body.challengeId);
    if (!challenge)
      throw new ChartWardenError("CHALLENGE_EXPIRED_OR_INVALID", "challenge expired or invalid", 400);
    if (challenge.sessionId !== session.sessionId) {
      throw new ChartWardenError("CHALLENGE_SESSION_MISMATCH", "challenge session mismatch", 400);
    }
    if (challenge.factor !== factor) {
      throw new ChartWardenError("CHALLENGE_FACTOR_MISMATCH", "challenge factor mismatch", 400);
    }

    // Payload shape per factor (the spec's TypeBox `assertion` / `^[0-9]{6}$` gates).
    if (factor === "webauthn" && body.assertion == null) {
      throw new ChartWardenError("MALFORMED_VERIFY_PAYLOAD", "malformed verify payload", 400);
    }
    if (
      factor === "totp" &&
      (typeof body.totpCode !== "string" || !/^[0-9]{6}$/.test(body.totpCode))
    ) {
      throw new ChartWardenError("MALFORMED_VERIFY_PAYLOAD", "malformed verify payload", 400);
    }

    const verdict = await deps.verifier.verify({
      userId: session.userId,
      factor,
      webauthnChallenge: challenge.webauthnChallenge,
      assertion: body.assertion,
      totpCode: typeof body.totpCode === "string" ? body.totpCode : undefined,
    });
    const auditCtx = auditContextFor(request, session);

    if (!verdict.ok) {
      await deps.challenges.recordFailure(session.sessionId);
      const failureCount = await deps.challenges.recentFailureCount(session.sessionId);
      await auditStepUpFailed(deps.audit, auditCtx, {
        sessionId: session.sessionId,
        factor,
        failureReason: verdict.reason ?? "verification_failed",
        failureCount,
      });
      await deps.outbox?.publish({
        eventName: "m2.session.step_up.failed",
        payload: {
          sessionId: session.sessionId,
          factor,
          failureReason: verdict.reason ?? "verification_failed",
          failureCount,
        },
        organizationId: session.organizationId,
        aggregateKind: "session",
        aggregateId: session.sessionId,
      });

      if (failureCount >= STEP_UP_POLICY.lockoutThreshold) {
        await deps.writer.terminate({ sessionId: session.sessionId, reason: "step_up_lockout" });
        await auditStepUpLockout(deps.audit, auditCtx, {
          sessionId: session.sessionId,
          factor,
          failureCount,
        });
        await deps.outbox?.publish({
          eventName: "m2.session.terminated_step_up_lockout",
          payload: { sessionId: session.sessionId, factor, failureCount },
          organizationId: session.organizationId,
          aggregateKind: "session",
          aggregateId: session.sessionId,
        });
        throw new ChartWardenError("SESSION_LOCKED", "session locked", 423, [
          { code: "STEP_UP_LOCKOUT", message: "too many failed step-up attempts" },
        ]);
      }
      throw new ChartWardenError("STEP_UP_FAILED", "step up failed", 401);
    }

    // Success: paired-write the step-up freshness, clear the challenge + failure counter.
    const now = new Date();
    await deps.writer.recordStepUp({ sessionId: session.sessionId, factor, at: now });
    await deps.challenges.del(body.challengeId);
    await deps.challenges.clearFailures(session.sessionId);
    await auditStepUpCompleted(deps.audit, auditCtx, {
      sessionId: session.sessionId,
      factor,
      source: "explicit_route",
    });
    await deps.outbox?.publish({
      eventName: "m2.session.step_up.completed",
      payload: { sessionId: session.sessionId, factor, source: "explicit_route" },
      organizationId: session.organizationId,
      aggregateKind: "session",
      aggregateId: session.sessionId,
    });

    return reply.code(200).send({
      lastStepUpAt: now.toISOString(),
      lastStepUpFactor: factor,
    });
  });
}
