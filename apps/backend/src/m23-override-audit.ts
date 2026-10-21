// apps/backend/src/m23-override-audit.ts — the live M23 `AuditEventPort` (§4.5 validation override).
//
// `POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override` records ONE prominent M4 `audit_event` in
// the same transaction as the override and stamps its id onto the NOT-NULL `validation_override.m4_audit_event_id`.
// M23 may not write `audit_event` itself (a HELPER_ONLY table: only `@chartwarden/audit` may), so the composition root (this file lives at the app
// root, not in bootstrap/ or a module, because module-1-boundary forbids bootstrap -> module imports and M23 may not import
// @chartwarden/audit) binds this adapter over the sanctioned helper (`auditReturningId`) — the same convention M25's `m4RemittanceAuditPort` uses.
//
// WHAT IT RECORDS: ids, the rule key, the applied role and the reason LENGTH, with the request's correlation id, request id,
// source IP and user agent (the same correlation id is set as the transaction's `app.correlation_id`, so the row-level
// `validation_override` write-audit trigger event carries it too). NEVER the free-text reason: that lives only on
// `validation_override.reason` (org-scoped, RLS, append-only). Migration 1062 makes the row-level trigger scrub it as well
// (`audit_scrub` writes "<changed>"), so it reaches NO audit_event, outbox payload or log. The helper additionally redacts
// through the audit denylist.
import { auditReturningId } from "@chartwarden/audit";
import type { AuditEventPort } from "./modules/23-billing-medicare/routes";

/** The audit event type for an applied M23 validation override. */
export const M23_OVERRIDE_AUDIT_EVENT = "m23.validation.override_applied";

export function buildM23OverrideAuditPort(): AuditEventPort {
  return {
    async recordOverrideAudit(tx, input) {
      const auditEventId = await auditReturningId(
        tx as Parameters<typeof auditReturningId>[0],
        {
          organizationId: input.organizationId,
          userId: input.actorUserId,
          actorKind: "user",
          actorRole: input.overrideRole,
          correlationId: input.correlationId,
          requestId: input.requestId,
          sourceIp: input.sourceIp,
          userAgent: input.userAgent,
        },
        {
          eventType: M23_OVERRIDE_AUDIT_EVENT,
          resourceKind: "validation_result",
          resourceId: input.resultId,
          outcome: "success",
          severity: "warn",
          context: {
            claimId: input.claimId,
            validationRunId: input.validationRunId,
            ruleKey: input.ruleKey,
            overrideRole: input.overrideRole,
            reasonLength: input.reason.length,
          },
        },
      );
      return { auditEventId };
    },
  };
}
