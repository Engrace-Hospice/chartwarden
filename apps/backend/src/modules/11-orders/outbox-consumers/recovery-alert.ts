// apps/backend/src/modules/11-orders/outbox-consumers/recovery-alert.ts — F-203 (#248): DURABLE delivery of the
// two-person lab-recovery control's compliance alerts.
//
// THE GAP. F-202 raised its alerts (`recovery_executed` / `_cancelled` / `_expired`) from the service AFTER the recovery's
// transaction committed, through `AlertEmitter.emit()` — which runs in its OWN transaction — and swallowed a failure with a
// log line. The recovery row and the append-only ledger were the durable record, but a compliance officer's notification
// was best-effort: an emitter outage at the wrong moment meant an executed duplicate-risk recovery raised NO alert, and
// nothing would ever retry it.
//
// THE FIX (the F-187 `lab-cancellation-required` shape, reused): the recovery's OWN transaction publishes an
// `m11.order.recovery_alert_requested` outbox event carrying the alert intent — the outbox row commits or rolls back WITH
// the recovery — and THIS consumer hands it to M36. A failure makes `handle` throw, so the relay redelivers it; the alert's
// own correlation id (`alert` is unique on `(organization_id, correlation_id)`) makes every redelivery idempotent, so a
// retry after a partial success can never page twice.
//
// NO PHI: the payload is ids, counts and flags built by `buildRecoveryAlert` / `buildRecoveryAnomalyAlert` — never the lab
// contact's name, the lab reference or a patient id — and this consumer forwards it verbatim.
import type { LabCancellationAlertPort } from "./lab-cancellation-required";

export const M11_RECOVERY_ALERT_CONSUMER = {
  eventNames: ["m11.order.recovery_alert_requested"] as const,
  consumerName: "m11.recovery-alert",
} as const;

/** The M36 alert `eventType`s this consumer may deliver (each is a platform-default `alert_rule` key in the seed). */
export const M11_RECOVERY_ALERT_TYPES = [
  "m11.order.recovery_executed",
  "m11.order.recovery_cancelled",
  "m11.order.recovery_expired",
  "m11.order.recovery_anomaly",
] as const;

export interface RecoveryAlertDeps {
  readonly alerts: LabCancellationAlertPort;
}

interface AlertIntent {
  readonly alertType: string;
  readonly severity: string;
  readonly correlationId: string;
  readonly alertPayload: Record<string, unknown>;
}

function intentOf(payload: unknown): AlertIntent {
  const p = (payload ?? {}) as Record<string, unknown>;
  const name = M11_RECOVERY_ALERT_CONSUMER.consumerName;
  const alertType = p.alertType;
  const severity = p.severity;
  const correlationId = p.correlationId;
  const alertPayload = p.alertPayload;
  if (
    typeof alertType !== "string" ||
    !(M11_RECOVERY_ALERT_TYPES as readonly string[]).includes(alertType)
  ) {
    // A permanent (poison) failure: name it and let the relay dead-letter it rather than retry forever.
    throw new Error(`${name}: unknown alertType '${String(alertType)}'`);
  }
  if (
    typeof severity !== "string" ||
    typeof correlationId !== "string" ||
    correlationId.length === 0
  ) {
    throw new Error(`${name}: payload has no severity / correlationId`);
  }
  if (typeof alertPayload !== "object" || alertPayload === null || Array.isArray(alertPayload)) {
    throw new Error(`${name}: payload has no alertPayload object`);
  }
  return {
    alertType,
    severity,
    correlationId,
    alertPayload: alertPayload as Record<string, unknown>,
  };
}

export function buildM11RecoveryAlertConsumer(deps: RecoveryAlertDeps) {
  return {
    consumerName: M11_RECOVERY_ALERT_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [...M11_RECOVERY_ALERT_CONSUMER.eventNames],
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const intent = intentOf(event.payload);
      // Throws on an emitter failure ⇒ the relay retries; the correlation id dedupes a redelivery after success.
      await deps.alerts.emit(event.organizationId, {
        eventType: intent.alertType,
        payload: intent.alertPayload,
        severity: intent.severity,
        correlationId: intent.correlationId,
      });
    },
  };
}
