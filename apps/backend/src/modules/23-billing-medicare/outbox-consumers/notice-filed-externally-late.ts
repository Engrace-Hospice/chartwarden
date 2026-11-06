// apps/backend/src/modules/23-billing-medicare/outbox-consumers/notice-filed-externally-late.ts — a NOE / NOTR that a tenant billing
// outside ChartWarden filed AFTER the due date and recorded afterwards (owner decision, round 2, Q4).
//
// The deadline watchdog cannot see it: a notice recorded as filed leaves its scan, so no `window_breached` fires for it, and nobody else
// would ever hear that the tenant filed late. The record route therefore publishes `m23.noe|notr.filed_externally_late` (catalogued,
// ids and dates only) in its own transaction; this M23 consumer turns each delivery into
//   - the M36 alert to the tenant (rule `m23.{noe,notr}.filed_externally_late`: billing manager, compliance officer, org admin), and
//   - an org-less platform-ops notice (the ops sink: a log line and the optional webhook), so operations hears of it too.
// A failed alert FAILS the delivery (the relay retries it; the emitter's correlation id keeps a retry from alerting twice). The ops
// notice is fire-and-forget and never throws. Nothing here reads or writes a table.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import type { WorkerAlertPort } from "../jobs/m23-jobs";

export const M23_NOTICE_FILED_LATE_EVENTS = [
  "m23.noe.filed_externally_late",
  "m23.notr.filed_externally_late",
] as const;

/** The shape of the platform-ops notice sink (`bootstrap/platform-ops-notices.ts`), named structurally. */
export type NoticeOpsSink = (notice: {
  readonly kind: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
}) => void;

export interface M23NoticeFiledLateDeps {
  readonly alerts: WorkerAlertPort;
  readonly opsNotice?: NoticeOpsSink;
}

const requiredString = (payload: Record<string, unknown>, field: string): string => {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`M23 late external filing event has invalid '${field}'`);
  }
  return value;
};

export function buildM23NoticeFiledLateConsumer(
  deps: M23NoticeFiledLateDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m23.notice-filed-externally-late",
    consumerModule: "m23",
    eventTypes: M23_NOTICE_FILED_LATE_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      const payload = event.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("M23 late external filing event payload must be an object");
      }
      const fields = payload as Record<string, unknown>;
      const noticeKind = event.eventType === "m23.noe.filed_externally_late" ? "noe" : "notr";
      const noticeId = requiredString(fields, noticeKind === "noe" ? "noeId" : "notrId");
      const admissionId = requiredString(fields, "admissionId");
      const filedOn = requiredString(fields, "filedOn");
      const windowTargetAt = requiredString(fields, "windowTargetAt");
      await deps.alerts.dispatch({
        alertCode: event.eventType,
        severity: "critical",
        organizationId: event.organizationId,
        payload: {
          [noticeKind === "noe" ? "noeId" : "notrId"]: noticeId,
          admissionId,
          filedOn,
          windowTargetAt,
        },
      });
      deps.opsNotice?.({
        kind: "m23.notice_filed_late",
        summary: `a tenant recorded a ${noticeKind.toUpperCase()} it filed outside ChartWarden after the due date`,
        details: {
          organizationId: event.organizationId,
          noticeKind,
          noticeId,
          filedOn,
          windowTargetAt,
        },
        correlationId: event.id,
      });
    },
  };
}
