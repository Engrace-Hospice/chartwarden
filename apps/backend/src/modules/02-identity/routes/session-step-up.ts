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
import { requireSession } from "@wardenx/auth";
import { STEP_UP_POLICY, UnauthorizedError, ValidationError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  auditStepUpCompleted,
  auditStepUpFailed,
  auditStepUpLockout,
} from "../audit/step-up-audit";
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
 * violation (the validation layer). Returns null after the reply has been sent for SMS.
 */
function readFactor(body: unknown, reply: FastifyReply): StepUpQualifyingFactor | null {
  const factor = (body as { factor?: unknown } | null)?.factor;
  if (factor === "sms") {
    reply.code(400).send({ error: "sms_not_step_up_qualifying" });
    return null;
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
 * TASK-010 (SEC-005/OPS-010): `WEBAUTHN_RP_ID` unset previously fell through to a hardcoded
 * `"localhost"` regardless of `NODE_ENV` — in production that silently weakens (or outright breaks)
 * every WebAuthn ceremony instead of refusing to boot. `bootstrap/env.ts` now requires the var in
 * production too; this is the defense-in-depth twin at the point of use.
 */
function resolveWebauthnRpId(): string {
  const configured = process.env.WEBAUTHN_RP_ID;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("WEBAUTHN_RP_ID is required in production");
  }
  return "localhost";
}

export function registerSessionStepUpRoutes(app: FastifyInstance, deps: StepUpRouteDeps): void {
  const newChallengeId = deps.newChallengeId ?? (() => crypto.randomUUID());
  const newWebauthnChallenge =
    deps.newWebauthnChallenge ?? (() => crypto.randomUUID().replace(/-/g, ""));
  const rpId = deps.webauthnRpId ?? resolveWebauthnRpId();

  // --- Initiate a step-up challenge --------------------------------------------------------
  app.post("/api/v1/sessions/step-up/initiate", async (request, reply) => {
    const session = await resolveSessionOrThrow(deps, request);
    const factor = readFactor(request.body, reply);
    if (factor === null) return reply; // SMS already answered (400)

    const enrolled = await deps.enrollment.hasFactor({ userId: session.userId, factor });
    if (!enrolled) {
      return reply.code(400).send({
        error: factor === "webauthn" ? "webauthn_not_enrolled" : "totp_not_enrolled",
      });
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
    const factor = readFactor(request.body, reply);
    if (factor === null) return reply; // SMS already answered (400)

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
    if (!challenge) return reply.code(400).send({ error: "challenge_expired_or_invalid" });
    if (challenge.sessionId !== session.sessionId) {
      return reply.code(400).send({ error: "challenge_session_mismatch" });
    }
    if (challenge.factor !== factor) {
      return reply.code(400).send({ error: "challenge_factor_mismatch" });
    }

    // Payload shape per factor (the spec's TypeBox `assertion` / `^[0-9]{6}$` gates).
    if (factor === "webauthn" && body.assertion == null) {
      return reply.code(400).send({ error: "malformed_verify_payload" });
    }
    if (
      factor === "totp" &&
      (typeof body.totpCode !== "string" || !/^[0-9]{6}$/.test(body.totpCode))
    ) {
      return reply.code(400).send({ error: "malformed_verify_payload" });
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

      if (failureCount >= STEP_UP_POLICY.lockoutThreshold) {
        await deps.writer.terminate({ sessionId: session.sessionId, reason: "step_up_lockout" });
        await auditStepUpLockout(deps.audit, auditCtx, {
          sessionId: session.sessionId,
          factor,
          failureCount,
        });
        return reply.code(423).send({ error: "session_locked", reason: "step_up_lockout" });
      }
      return reply.code(401).send({ error: "step_up_failed" });
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

    return reply.code(200).send({
      lastStepUpAt: now.toISOString(),
      lastStepUpFactor: factor,
    });
  });
}
