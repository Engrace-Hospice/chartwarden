// apps/backend/src/modules/23-billing-medicare/outbox-consumers/baa-revoked.ts — a platform operator revoked a tenant's vendor BAA
// (ADR-0053 amendment; owner decision "build it").
//
// The revoke publishes `m23.tenant_clearinghouse.baa_revoked` (catalogued: the config id, the vendor, a closed reason code and counts)
// in its own transaction, so the tenant is told by the system and not by a runbook step. This M23 consumer turns each delivery into
//   - the M36 alert to the tenant (rule `m23.tenant_clearinghouse.baa_revoked`: billing manager, compliance officer, org admin): its
//     clearinghouse is out of service, what is held, and how many responses may still be owed, and
//   - an org-less platform-ops notice on EVERY revoke (the ops sink: a log line and the optional webhook), so operations hears of a
//     kill switch being thrown even when nobody reads the audit trail.
// Ids, a closed code and counts only: never the ticket reference, a document reference or any text. A failed alert FAILS the delivery
// (the relay retries it; the emitter's correlation id, which carries the event id, keeps a retry from alerting twice). The ops notice
// is fire-and-forget and never throws. Nothing here reads or writes a table.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { WorkerAlertPort } from "../jobs/m23-jobs";
import type { NoticeOpsSink } from "./notice-filed-externally-late";

export const M23_BAA_REVOKED_EVENT = "m23.tenant_clearinghouse.baa_revoked";

export interface M23BaaRevokedDeps {
  readonly alerts: WorkerAlertPort;
  readonly opsNotice?: NoticeOpsSink;
}

const requiredString = (payload: Record<string, unknown>, field: string): string => {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`M23 BAA revoked event has invalid '${field}'`);
  }
  return value;
};

const requiredCount = (payload: Record<string, unknown>, field: string): number => {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`M23 BAA revoked event has invalid '${field}'`);
  }
  return value;
};

export function buildM23BaaRevokedConsumer(deps: M23BaaRevokedDeps): OutboxConsumerBinding {
  return {
    consumerName: "m23.baa-revoked",
    consumerModule: "m23",
    eventTypes: [M23_BAA_REVOKED_EVENT],
    async handle(event: DispatchableOutboxEvent) {
      const payload = event.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("M23 BAA revoked event payload must be an object");
      }
      const fields = payload as Record<string, unknown>;
      const summary = {
        vendor: requiredString(fields, "vendor"),
        reasonCode: requiredString(fields, "reasonCode"),
        wasActive: fields.wasActive === true,
        attemptsInFlight: requiredCount(fields, "attemptsInFlight"),
        attemptsSentInWindow: requiredCount(fields, "attemptsSentInWindow"),
        queuedClaims: requiredCount(fields, "queuedClaims"),
        queuedCommercialSubmissions: requiredCount(fields, "queuedCommercialSubmissions"),
      };
      await deps.alerts.dispatch({
        alertCode: M23_BAA_REVOKED_EVENT,
        severity: "critical",
        organizationId: event.organizationId,
        payload: {
          // `...Id` keys are what the alert's correlation id is built from: the event id makes each revoke its own alert
          clearinghouseConfigId: requiredString(fields, "clearinghouseConfigId"),
          revocationId: event.id,
          ...summary,
        },
      });
      deps.opsNotice?.({
        kind: "m23.clearinghouse_baa_revoked",
        summary: `a platform operator revoked a tenant's ${summary.vendor} vendor BAA (${summary.reasonCode}); its claims, notices and response pulls are held`,
        // OPS_ALERT_WEBHOOK_URL is an outside receiver: the organization, the closed code and counts only (never a ticket or text).
        details: { organizationId: event.organizationId, ...summary },
        correlationId: event.id,
      });
    },
  };
}
