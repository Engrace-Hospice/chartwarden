// apps/backend/src/m23-override-audit.ts — the live M23 `AuditEventPort` (§4.5 validation override).
//
// `POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override` records ONE prominent M4 `audit_event` in
// the same transaction as the override and stamps its id onto the NOT-NULL `validation_override.m4_audit_event_id`.
// M23 may not write `audit_event` itself (a HELPER_ONLY table: only `@wardenx/audit` may), so the composition root (this file lives at the app
// root, not in bootstrap/ or a module, because module-1-boundary forbids bootstrap -> module imports and M23 may not import
// @wardenx/audit) binds this adapter over the sanctioned helper (`auditReturningId`) — the same convention M25's `m4RemittanceAuditPort` uses.
//
// WHAT IT RECORDS: ids, the rule key, the applied role and the reason LENGTH. NEVER the free-text reason: that lives only
// on `validation_override.reason` (org-scoped, RLS, append-only), and must not reach an audit snapshot, an outbox payload
// or a log. The helper additionally redacts through the audit denylist.
import { randomUUID } from "node:crypto";
import { auditReturningId } from "@wardenx/audit";
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
          correlationId: randomUUID(),
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
