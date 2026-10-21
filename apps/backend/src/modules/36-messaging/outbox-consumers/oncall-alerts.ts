// apps/backend/src/modules/36-messaging/outbox-consumers/oncall-alerts.ts — M36's consumer of M19's page-worthy
// events: the coverage-gap watchdog (GAP-057) and the two §4.8 SLA crons (GAP-057 follow-up).
//
//   event (M19 outbox)                           -> alert eventType (platform `alert_rule`)     severity
//   m19.oncall_shift.coverage_gap                -> m19.oncall.coverage_gap_detected            critical (system-locked)
//   m19.triage_call.callback_sla_breached        -> m19.triage.callback_sla_breached            warn
//   m19.triage_call.escalation_sla_breached      -> m19.triage.escalation_sla_breached          warn / critical (mandatory)
//
// RECIPIENTS: each platform `alert_rule` (packages/messaging seed) resolves them — coverage gap: `role_set`
// org_admin + clinical_supervisor; callback SLA: the `on_call` roster of the event's ProviderEntity; escalation
// SLA: `role_set` clinical_supervisor + don + org_admin. M36 never imports M19 — events are matched by name.
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload (a producer bug there must not re-route a
// critical page to another tenant).
//
// IDEMPOTENCY: `alert` is UNIQUE on (organization_id, correlation_id).
//   • coverage gap — the watchdog re-publishes a standing gap every 30 minutes (and D10 adds reactive ones), so
//     the key is ProviderEntity + the event's HOUR: at most one page per ProviderEntity per hour, however many
//     ticks or redeliveries — never silence (a new hour re-pages an unfilled hole), never a storm.
//   • SLA breaches — the cron already paces its own emissions (once per callback wait; at most every 30 minutes
//     per escalation), so the key is the OUTBOX EVENT ID: a redelivery collapses, a fresh emission pages.
//
// NO PHI: ids, enums, minutes and instants only. A malformed event THROWS (relay retry -> DLQ — a visible
// failure, never a silently dropped page).
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

/** The platform `alert_rule` key (an alert-rule key, distinct from the outbox event that triggers it). */
export const M19_COVERAGE_GAP_ALERT_TYPE = "m19.oncall.coverage_gap_detected" as const;
export const M19_CALLBACK_SLA_ALERT_TYPE = "m19.triage.callback_sla_breached" as const;
export const M19_ESCALATION_SLA_ALERT_TYPE = "m19.triage.escalation_sla_breached" as const;

export const M36_ONCALL_ALERT_CONSUMER = "m36.oncall-alerts" as const;

export const M36_ONCALL_ALERT_EVENT_TYPES = [
  "m19.oncall_shift.coverage_gap",
  "m19.triage_call.callback_sla_breached",
  "m19.triage_call.escalation_sla_breached",
] as const;

/** Characters of an ISO instant that identify its hour (`2026-09-10T15`). */
const ISO_HOUR_LENGTH = 13;

type Payload = Record<string, unknown>;

function requireString(eventType: string, p: Payload, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_ONCALL_ALERT_CONSUMER}: ${eventType} payload has no ${key}`);
  }
  return v;
}

function requireMinutes(eventType: string, p: Payload, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error(`${M36_ONCALL_ALERT_CONSUMER}: ${eventType} payload has no numeric ${key}`);
  }
  return v;
}

type AlertInput = Parameters<AlertEmitter["emit"]>[1];

function coverageGapAlert(event: DispatchableOutboxEvent, p: Payload): AlertInput {
  const eventType = "m19.oncall_shift.coverage_gap";
  const providerEntityId = requireString(eventType, p, "providerEntityId");
  const hour = event.createdAt.toISOString().slice(0, ISO_HOUR_LENGTH);
  return {
    eventType: M19_COVERAGE_GAP_ALERT_TYPE,
    severity: "critical",
    correlationId: `outbox:${M19_COVERAGE_GAP_ALERT_TYPE}:${providerEntityId}:${hour}`,
    payload: {
      eventType: M19_COVERAGE_GAP_ALERT_TYPE,
      providerEntityId,
      gapStartsAt: requireString(eventType, p, "gapStartsAt"),
      gapEndsAt: requireString(eventType, p, "gapEndsAt"),
      discipline: requireString(eventType, p, "discipline"),
      deepLink: "/triage/shifts",
      message: "No on-call clinical RN is scheduled for part of the next 24 hours.",
    },
  };
}

function callbackSlaAlert(event: DispatchableOutboxEvent, p: Payload): AlertInput {
  const eventType = "m19.triage_call.callback_sla_breached";
  const triageCallId = requireString(eventType, p, "triageCallId");
  return {
    eventType: M19_CALLBACK_SLA_ALERT_TYPE,
    severity: "warn",
    correlationId: `outbox:${M19_CALLBACK_SLA_ALERT_TYPE}:${event.id}`,
    payload: {
      eventType: M19_CALLBACK_SLA_ALERT_TYPE,
      providerEntityId: requireString(eventType, p, "providerEntityId"),
      triageCallId,
      slaTargetMinutes: requireMinutes(eventType, p, "slaTargetMinutes"),
      minutesElapsed: requireMinutes(eventType, p, "minutesElapsed"),
      deepLink: `/triage/calls/${triageCallId}`,
      message: "A caller is still waiting on a callback past the target time.",
    },
  };
}

function escalationSlaAlert(event: DispatchableOutboxEvent, p: Payload): AlertInput {
  const eventType = "m19.triage_call.escalation_sla_breached";
  const triageCallId = requireString(eventType, p, "triageCallId");
  const mandatory = p.mandatory === true;
  return {
    eventType: M19_ESCALATION_SLA_ALERT_TYPE,
    severity: mandatory ? "critical" : "warn",
    correlationId: `outbox:${M19_ESCALATION_SLA_ALERT_TYPE}:${event.id}`,
    payload: {
      eventType: M19_ESCALATION_SLA_ALERT_TYPE,
      providerEntityId: requireString(eventType, p, "providerEntityId"),
      triageCallId,
      escalationId: requireString(eventType, p, "escalationId"),
      tier: requireString(eventType, p, "tier"),
      mandatory,
      slaTargetMinutes: requireMinutes(eventType, p, "slaTargetMinutes"),
      minutesOpen: requireMinutes(eventType, p, "minutesOpen"),
      deepLink: "/triage/escalations",
      message: "A triage escalation has not been acknowledged within its time limit.",
    },
  };
}

const BUILDERS: Readonly<
  Record<
    (typeof M36_ONCALL_ALERT_EVENT_TYPES)[number],
    (event: DispatchableOutboxEvent, p: Payload) => AlertInput
  >
> = {
  "m19.oncall_shift.coverage_gap": coverageGapAlert,
  "m19.triage_call.callback_sla_breached": callbackSlaAlert,
  "m19.triage_call.escalation_sla_breached": escalationSlaAlert,
};

export function buildM36OncallAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_ONCALL_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_ONCALL_ALERT_EVENT_TYPES,
    async handle(event: DispatchableOutboxEvent) {
      const build = (BUILDERS as Record<string, (typeof BUILDERS)[keyof typeof BUILDERS]>)[
        event.eventType
      ];
      if (build === undefined) {
        throw new Error(`${M36_ONCALL_ALERT_CONSUMER}: unexpected event ${event.eventType}`);
      }
      const p = (event.payload ?? {}) as Payload;
      await alerts.emit(event.organizationId, build(event, p));
    },
  };
}
