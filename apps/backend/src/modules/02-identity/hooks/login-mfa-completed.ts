// apps/backend/src/modules/02-identity/hooks/login-mfa-completed.ts — M2-T05 login-MFA
// step-up initialization (M2 spec §4.4.2; W-M2-08; §statechart "Login success with MFA").
//
// When a login completes WITH an MFA challenge (TOTP or WebAuthn), the freshly-issued
// session's step-up state is seeded to the login moment — a just-logged-in user has a
// step-up window without an immediate re-challenge (matches user expectations; avoids friction
// on routine privileged actions right after login). SMS does NOT initialize step-up (D9): it
// is the accessibility fallback, not a step-up-qualifying factor.
//
// This is a plain function the Better Auth login flow calls post-MFA (the adapter wiring is
// M2-T07); it shares the SessionStepUpWriter + audit() surface with the explicit step-up route
// so login-MFA and route-driven step-up write the session field through one path.
import type { AuditContext, AuditExecutor } from "@chartwarden/audit";
import type { StepUpFactor } from "@chartwarden/types";
import { auditStepUpCompleted } from "../audit/step-up-audit";
import type { SessionStepUpWriter, StepUpQualifyingFactor } from "../step-up-ports";

export interface LoginMfaCompletedDeps {
  writer: SessionStepUpWriter;
  audit: AuditExecutor;
}

export interface LoginMfaCompletedContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  /** The MFA factor verified at login, or null when no MFA was performed. */
  readonly mfaFactor: StepUpFactor | null;
  readonly completedAt: Date;
  /** Correlation id stitching the audit row to the login request. */
  readonly correlationId: string;
}

/**
 * Initialize a session's step-up state from a login-time MFA challenge. No-op when no MFA was
 * performed or the factor was SMS (D9). On a qualifying factor it paired-writes
 * lastStepUpAt/lastStepUpFactor and audits `m2.session.step_up.completed` with
 * `source: 'login_mfa'` at compliance retention.
 */
export async function onLoginMfaCompleted(
  deps: LoginMfaCompletedDeps,
  ctx: LoginMfaCompletedContext,
): Promise<void> {
  if (!ctx.mfaFactor || ctx.mfaFactor === "sms") return;
  const factor: StepUpQualifyingFactor = ctx.mfaFactor;

  await deps.writer.recordStepUp({
    sessionId: ctx.sessionId,
    factor,
    at: ctx.completedAt,
  });

  const auditCtx: AuditContext = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    correlationId: ctx.correlationId,
  };
  await auditStepUpCompleted(deps.audit, auditCtx, {
    sessionId: ctx.sessionId,
    factor,
    source: "login_mfa",
  });
}
