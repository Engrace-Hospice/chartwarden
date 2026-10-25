// apps/backend/src/m41-override-audit.ts — the live M41 `CommercialAuditPort` (issue #722, the m23-override-audit.ts pattern).
//
// An applied commercial validation override records ONE prominent M4 `audit_event` in the same transaction as the override and
// stamps its id onto the NOT-NULL `commercial_validation_override.m4_audit_event_id`. M41 may not write `audit_event` itself
// (a HELPER_ONLY table: only `@chartwarden/audit` may), so the composition root binds this adapter over the sanctioned helper.
//
// WHAT IT RECORDS: ids, the rule key and the reason LENGTH, with the request's correlation id, request id, source IP and user
// agent (the same correlation id is the transaction's `app.correlation_id`, so the row-level write-audit trigger carries it
// too). NEVER the free-text reason: it lives only on `commercial_validation_override.reason` (org-scoped, RLS, append-only) and
// the row-level trigger scrubs it.
import { auditReturningId } from "@chartwarden/audit";
import type { CommercialAuditPort } from "./modules/41-billing-commercial";

/** The audit event type for an applied M41 validation override. */
export const M41_OVERRIDE_AUDIT_EVENT = "m41.validation.override_applied";

export function buildM41OverrideAuditPort(): CommercialAuditPort {
  return {
    async recordOverrideAudit(tx, input) {
      const auditEventId = await auditReturningId(
        tx as unknown as Parameters<typeof auditReturningId>[0],
        {
          organizationId: input.organizationId,
          userId: input.actorUserId,
          actorKind: "user",
          correlationId: input.correlationId,
          requestId: input.requestId,
          sourceIp: input.sourceIp,
          userAgent: input.userAgent,
        },
        {
          eventType: M41_OVERRIDE_AUDIT_EVENT,
          resourceKind: "commercial_validation_result",
          resourceId: input.validationResultId,
          outcome: "success",
          severity: "warn",
          context: {
            claimId: input.claimId,
            ruleKey: input.ruleKey,
            reasonLength: input.reasonLength,
          },
        },
      );
      return { auditEventId };
    },
  };
}
