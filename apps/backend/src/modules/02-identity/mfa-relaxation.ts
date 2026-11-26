// apps/backend/src/modules/02-identity/mfa-relaxation.ts — CW-AC-45: a boot that runs with the second-factor matrix
// relaxed (`CHARTWARDEN_MFA_ENFORCEMENT=false`) says so loudly and leaves one critical audit row,
// `m2.auth.mfa_enforcement_relaxed`, carrying the recorded reason. Production refuses to serve a relaxation it could not
// record: a relaxation that leaves no trail is the thing the control forbids. (The reason itself is REQUIRED in production
// by `collectEnvProblems` in bootstrap/env.ts, before this runs.)
//
// Extracted from the composition root so the three outcomes are unit-testable and the real platform audit writer is proven
// live (m2-auth-hardening.live): enforced writes nothing; relaxed writes one row; a failed write is fatal in production only.
import { randomUUID } from "node:crypto";
import type { auditPlatformEvent } from "@chartwarden/audit";
import { AUTH_AUDIT_EVENTS, mfaRelaxationReason } from "@chartwarden/auth";

type PlatformAuditEvent = Parameters<typeof auditPlatformEvent>[1];

export interface MfaRelaxationDeps {
  readonly enforced: boolean;
  readonly env: {
    readonly NODE_ENV?: string | undefined;
    readonly CHARTWARDEN_MFA_RELAXATION_REASON?: string | undefined;
  };
  /** The platform-scoped audit writer (`auditPlatformEvent` over the app DB handle in production). */
  readonly audit: (event: PlatformAuditEvent) => Promise<unknown>;
  readonly log: {
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

export async function recordMfaRelaxation(deps: MfaRelaxationDeps): Promise<void> {
  if (deps.enforced) return;
  const reason = mfaRelaxationReason(deps.env);
  deps.log.warn(
    { reason },
    "the server-side MFA matrix is RELAXED (CHARTWARDEN_MFA_ENFORCEMENT=false): staff sessions need no second factor",
  );
  try {
    await deps.audit({
      eventType: AUTH_AUDIT_EVENTS.mfaEnforcementRelaxed,
      resourceKind: "auth_policy",
      outcome: "success",
      severity: "critical",
      correlationId: randomUUID(),
      retentionClass: "compliance",
      context: { reason, nodeEnv: deps.env.NODE_ENV ?? "unset" },
    });
  } catch (err) {
    deps.log.error({ err }, "recording the MFA relaxation in the audit trail failed");
    if (deps.env.NODE_ENV === "production")
      throw new Error(
        "refusing to boot with the MFA matrix relaxed and the relaxation unaudited (m2.auth.mfa_enforcement_relaxed)",
      );
  }
}
