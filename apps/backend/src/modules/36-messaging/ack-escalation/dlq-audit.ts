// apps/backend/src/modules/36-messaging/ack-escalation/dlq-audit.ts - WP 4.4: the `m36.dlq_job` audit row (OPS-035, no silent DLQ
// drain) for a dead escalation timer job. The payload arrives already hashed (`buildDlqAuditRecord`); the row names the request, so
// an operator can find it, and is written under the job's own tenant context. Ids, a hash and an error CLASS only.
import { type AuditExecutor, audit } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import type { DlqAuditRecord } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";

export function createDlqAuditRecorder(db: DbClient) {
  return (
    organizationId: string,
    record: DlqAuditRecord,
    requestId: string | null,
  ): Promise<void> =>
    withOrgContext(db, systemOrgContext(organizationId), (tx) =>
      audit(
        tx as unknown as AuditExecutor,
        { organizationId, userId: null, actorKind: "system", correlationId: record.jobId },
        {
          eventType: "m36.dlq_job",
          resourceKind: "message_acknowledgment_request",
          ...(requestId ? { resourceId: requestId } : {}),
          outcome: "failure",
          severity: "critical",
          context: { ...record },
        },
      ),
    );
}
