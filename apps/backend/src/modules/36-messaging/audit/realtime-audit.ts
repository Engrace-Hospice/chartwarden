// apps/backend/src/modules/36-messaging/audit/realtime-audit.ts — ADR-0054 item 12: socket connect/disconnect rows.
// Org-scoped under `withOrgContext`, written through @wardenx/audit (never a direct insert). Ids and a reason only.
import { type AuditContext, type AuditExecutor, audit } from "@wardenx/audit";
import { withOrgContext } from "@wardenx/tenancy";
import type { RealtimeAuditEvent } from "../../../bootstrap/realtime";

type Db = Parameters<typeof withOrgContext>[0];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRealtimeAuditWriter(db: Db, newCorrelationId = () => crypto.randomUUID()) {
  return async (event: RealtimeAuditEvent): Promise<void> => {
    const ctx: AuditContext = {
      organizationId: event.organizationId,
      userId: event.userId,
      actorKind: "user",
      correlationId: newCorrelationId(),
    };
    const sessionIsUuid = UUID_SHAPE.test(event.sessionId);
    await withOrgContext(db, { organizationId: event.organizationId, userId: event.userId }, (tx) =>
      audit(tx as unknown as AuditExecutor, ctx, {
        eventType: `m36.realtime.${event.kind}`,
        resourceKind: "session",
        ...(sessionIsUuid ? { resourceId: event.sessionId } : {}),
        outcome: "success",
        severity: "info",
        retentionClass: "operational",
        context: {
          ...(sessionIsUuid ? {} : { sessionRef: event.sessionId }),
          ...(event.kind === "disconnected"
            ? { reason: event.reason, forced: event.forced, durationMs: event.durationMs }
            : {}),
        },
      }),
    );
  };
}
