// apps/backend/src/m23-clearinghouse-audit.ts — the live `ClearinghouseAuditPort` (the m41-override-audit.ts pattern): binds the
// tenant clearinghouse route service's field-level audit row over the sanctioned `@chartwarden/audit` helper.
//
// WHAT IT RECORDS: the acting user and membership, the config row id, the NAMES of the changed fields and a few codes, with the
// request's correlation id, request id, source IP and user agent. NEVER a credential, a BAA document reference, an evidence
// note or any other value: the row-level trigger already scrubs the secret and records that it changed.
import { audit } from "@chartwarden/audit";
import type { ClearinghouseAuditPort } from "./modules/23-billing-medicare/tenant-clearinghouse/audit-port";

export function buildClearinghouseAuditPort(): ClearinghouseAuditPort {
  return {
    async record(tx, entry) {
      await audit(
        tx as unknown as Parameters<typeof audit>[0],
        {
          organizationId: entry.organizationId,
          userId: entry.actorUserId,
          actorKind: "user",
          correlationId: entry.request?.correlationId ?? entry.request?.requestId ?? "",
          ...(entry.request?.requestId ? { requestId: entry.request.requestId } : {}),
          ...(entry.request?.sourceIp ? { sourceIp: entry.request.sourceIp } : {}),
          ...(entry.request?.userAgent ? { userAgent: entry.request.userAgent } : {}),
        },
        {
          eventType: entry.eventType,
          resourceKind: "tenant_clearinghouse_config",
          resourceId: entry.resourceId,
          outcome: "success",
          severity: "warn",
          retentionClass: "compliance",
          context: {
            actorMembershipId: entry.actorMembershipId,
            changedFields: [...entry.changedFields],
            ...(entry.detail ?? {}),
          },
        },
      );
    },
  };
}
