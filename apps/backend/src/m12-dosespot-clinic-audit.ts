// apps/backend/src/m12-dosespot-clinic-audit.ts — the live `ClinicAuditPort` (the m23-clearinghouse-audit.ts pattern): binds the
// tenant DoseSpot route service's field-level audit row over the sanctioned `@chartwarden/audit` helper.
//
// WHAT IT RECORDS: the acting user and membership, the row id, the NAMES of the changed fields and a few codes, with the
// request's correlation id, request id, source IP and user agent. NEVER a credential, an NPI or any other value: the row-level
// trigger already scrubs the sealed secret and records that it changed.
import { audit } from "@chartwarden/audit";
import type { ClinicAuditPort } from "./modules/12-dosespot/tenant-config/audit-port";

export function buildClinicAuditPort(): ClinicAuditPort {
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
          resourceKind: entry.resourceKind,
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
