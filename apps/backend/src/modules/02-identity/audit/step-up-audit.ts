// apps/backend/src/modules/02-identity/audit/step-up-audit.ts — M2-T05 step-up audit
// events (M2 spec §4.4, §8.1; §statechart "Step-up challenge …" rows).
//
// Every step-up state change is auditable at `compliance` retention (HIPAA floor; ADR-0004).
// These helpers go through the mandated @chartwarden/audit `audit()` surface — never a direct
// `audit_event` insert — so each snapshot is run through the PHI field denylist and filed
// under the right retention class. The `tx` (AuditExecutor) is injected: production passes the
// Drizzle transaction so the audit row commits atomically with the session write (§7.3); the
// slice passes an in-memory executor (see step-up-ports.ts).
import { type AuditContext, type AuditExecutor, audit } from "@chartwarden/audit";
import type { StepUpFactor } from "@chartwarden/types";

/** The three step-up audit event types (dotted `m2.session.step_up.*`). */
export const STEP_UP_AUDIT_EVENTS = {
  completed: "m2.session.step_up.completed",
  failed: "m2.session.step_up.failed",
  lockout: "m2.session.terminated_step_up_lockout",
} as const;

const RESOURCE_KIND = "session";

/** Where a step-up was initialized from (login MFA vs the explicit step-up route). */
export type StepUpSource = "login_mfa" | "explicit_route";

/** Record a successful step-up (login-MFA init or explicit route) at compliance retention. */
export async function auditStepUpCompleted(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { sessionId: string; factor: StepUpFactor; source: StepUpSource },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: STEP_UP_AUDIT_EVENTS.completed,
    resourceKind: RESOURCE_KIND,
    resourceId: input.sessionId,
    outcome: "success",
    retentionClass: "compliance",
    context: { factor: input.factor, source: input.source },
  });
}

/** Record a failed step-up attempt (carries the running failure count for lockout accounting). */
export async function auditStepUpFailed(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { sessionId: string; factor: StepUpFactor; failureReason: string; failureCount: number },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: STEP_UP_AUDIT_EVENTS.failed,
    resourceKind: RESOURCE_KIND,
    resourceId: input.sessionId,
    outcome: "failure",
    severity: "warn",
    retentionClass: "compliance",
    context: {
      factor: input.factor,
      failureReason: input.failureReason,
      failureCount: input.failureCount,
    },
  });
}

/** Record the forced session termination after the consecutive-failure lockout threshold. */
export async function auditStepUpLockout(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: { sessionId: string; factor: StepUpFactor; failureCount: number },
): Promise<void> {
  await audit(tx, ctx, {
    eventType: STEP_UP_AUDIT_EVENTS.lockout,
    resourceKind: RESOURCE_KIND,
    resourceId: input.sessionId,
    outcome: "failure",
    severity: "critical",
    retentionClass: "compliance",
    context: { factor: input.factor, failureCount: input.failureCount },
  });
}
