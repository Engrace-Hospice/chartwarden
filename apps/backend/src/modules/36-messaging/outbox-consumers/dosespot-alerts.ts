// apps/backend/src/modules/36-messaging/outbox-consumers/dosespot-alerts.ts - M36's consumer of M12's adapter-health events (review of
// slice 4, M3). M12 publishes these in the transaction of the cron tick (or breaker edge) that sees the fault; they had no consumer, so
// no tenant administrator was ever told that signed prescriptions were not reaching DoseSpot. This turns them into the M36 alerts:
//
//   m12.dosespot_degraded   -> m12.dosespot_degraded   critical  (seeded tenant_admins rule)
//   m12.dosespot_recovered  -> m12.dosespot_recovered  info      (seeded tenant_admins rule)
//   m12.medication_order.transmission_unconfirmed -> the same name  critical  (seeded tenant_admins rule): DoseSpot accepted a NewRx call
//                           but did not answer readably, so the order is HELD (never retried) until a person checks the prescriber's DoseSpot account
//   m12.medication_order.transmission_failed -> the same name  critical  (seeded tenant_admins rule): the retry budget was used up (or an
//                           administrator resolved a held order as never sent): the prescription has NOT reached the pharmacy
//
// `m12.dosespot_config.deactivated` is NOT consumed here: the clinic service raises that alert directly after its commit, so a second
// path would page twice (its seeded rule is in the same file as these two).
//
// ONE PAGE PER EVENT. The correlation id is `outbox:<alertType>:<event id>`, so a redelivered event is absorbed by the alert's
// `(organization_id, correlation_id)` dedupe and a later episode (a new event) pages again. `alert` has no open/resolved state to
// auto-resolve (only an `outcome`), so the honest equivalent of "recovered" is this paired notice to the same audience.
// TENANT from the envelope `event.organizationId`, never the payload copy. The alert carries ids, an error class, instants and a fixed
// sentence chosen here: nothing free-text from the payload, no name, no key. A malformed event THROWS (relay retry, then DLQ), never a
// silently dropped page.
import type { AlertEmitter, AlertSeverity } from "@chartwarden/messaging";

import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_DOSESPOT_ALERT_CONSUMER = "m36.dosespot-alerts" as const;

export const M36_DOSESPOT_ALERT_EVENT_TYPES = [
  "m12.dosespot_degraded",
  "m12.dosespot_recovered",
  "m12.medication_order.transmission_unconfirmed",
  "m12.medication_order.transmission_failed",
] as const;

export interface DosespotAlertPlan {
  readonly alertType: (typeof M36_DOSESPOT_ALERT_EVENT_TYPES)[number];
  readonly severity: AlertSeverity;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

/** What the administrator is told, by the fault M12 named in `lastErrorClass`; anything else is the circuit breaker opening. */
const DEGRADED_DETAIL: Readonly<Record<string, string>> = {
  config_unavailable:
    "ChartWarden could not read or open this organization's DoseSpot configuration, so signed prescriptions are not being sent and stay queued. A platform operator needs to check the configuration and its keys.",
  queued_orders_stale:
    "Signed prescriptions have been waiting to be sent to DoseSpot for over an hour. They stay queued and are sent once the cause is fixed; if an order cannot wait, follow your downtime prescribing procedure.",
};
const BREAKER_DETAIL =
  "E-prescribing through DoseSpot is temporarily unavailable. New prescriptions wait in the queue and are sent automatically when the service recovers.";
const RECOVERED_DETAIL =
  "The earlier DoseSpot e-prescribing problem has cleared. Queued prescriptions are being sent.";
const FAILED_DETAIL =
  "A signed prescription could not be sent to DoseSpot (every attempt failed, or the order cannot be sent as written). It has NOT reached the pharmacy. The prescriber must retransmit it from the order page.";
const RESOLVED_NOT_SENT_DETAIL =
  "An administrator confirmed that this prescription never reached DoseSpot. It has NOT been sent. The prescriber must retransmit it from the order page.";
const UNCONFIRMED_DETAIL =
  "DoseSpot accepted this prescription request but its answer could not be read, so the prescription may already exist there. ChartWarden is holding the order and will not send it again. Check the prescriber's DoseSpot account: if the prescription is there, the order was sent; if it is not, discontinue this order and sign a new one.";

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_DOSESPOT_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

/** The alert one adapter-health event raises. Throws on a malformed payload or an event this consumer does not own. */
export function planDosespotAlert(event: DispatchableOutboxEvent): DosespotAlertPlan {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  if (name === "m12.dosespot_degraded") {
    const breakerName = requireString(p, "breakerName", name);
    const openedAt = requireString(p, "openedAt", name);
    const lastErrorClass = requireString(p, "lastErrorClass", name);
    return {
      alertType: name,
      severity: "critical",
      correlationId: `outbox:${name}:${event.id}`,
      payload: {
        eventType: name,
        breakerName,
        openedAt,
        lastErrorClass,
        detail: DEGRADED_DETAIL[lastErrorClass] ?? BREAKER_DETAIL,
      },
    };
  }
  if (name === "m12.dosespot_recovered") {
    const breakerName = requireString(p, "breakerName", name);
    const closedAt = requireString(p, "closedAt", name);
    return {
      alertType: name,
      severity: "info",
      correlationId: `outbox:${name}:${event.id}`,
      payload: { eventType: name, breakerName, closedAt, detail: RECOVERED_DETAIL },
    };
  }
  if (name === "m12.medication_order.transmission_unconfirmed") {
    const orderId = requireString(p, "orderId", name);
    const lastErrorClass = requireString(p, "lastErrorClass", name);
    return {
      alertType: name,
      severity: "critical",
      correlationId: `outbox:${name}:${event.id}`,
      payload: { eventType: name, orderId, lastErrorClass, detail: UNCONFIRMED_DETAIL },
    };
  }
  if (name === "m12.medication_order.transmission_failed") {
    const orderId = requireString(p, "orderId", name);
    const lastErrorClass = requireString(p, "lastErrorClass", name);
    const retryCount = typeof p.retryCount === "number" ? p.retryCount : 0;
    return {
      alertType: name,
      severity: "critical",
      correlationId: `outbox:${name}:${event.id}`,
      payload: {
        eventType: name,
        orderId,
        lastErrorClass,
        retryCount,
        detail: lastErrorClass === "resolved_not_sent" ? RESOLVED_NOT_SENT_DETAIL : FAILED_DETAIL,
      },
    };
  }
  throw new Error(`${M36_DOSESPOT_ALERT_CONSUMER}: unexpected event ${name}`);
}

export function buildM36DosespotAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_DOSESPOT_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_DOSESPOT_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planDosespotAlert(event);
      await alerts.emit(event.organizationId, {
        eventType: plan.alertType,
        severity: plan.severity,
        correlationId: plan.correlationId,
        payload: plan.payload,
      });
    },
  };
}
