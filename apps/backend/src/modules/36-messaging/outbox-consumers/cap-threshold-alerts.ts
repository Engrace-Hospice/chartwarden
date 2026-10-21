// apps/backend/src/modules/36-messaging/outbox-consumers/cap-threshold-alerts.ts — GAP-040 / GAP-041.
// M36's consumer of M26's band-escalation event (M26 spec §4.9 / §4.10): `m26.cap.threshold_crossed` becomes one
// typed cap alert through the generic AlertEmitter (there is no cap_watch channel kind, M36-F03):
//
//   scope agency_aggregate  -> m26.cap.agency_watch_90 / agency_warn_95 / agency_breach_100
//   scope patient_aggregate -> m26.cap.patient_watch_90 / patient_warn_95 / patient_breach_100
//   scope inpatient         -> m26.cap.inpatient_watch_18 / inpatient_breach   (the 18% / 20% bands)
//
// RECIPIENTS come from the platform `alert_rule` rows seeded for each code (packages/messaging seed). M36 never
// imports M26 — the event is matched by name. IDEMPOTENCY: one correlation id per threshold event, and `alert`
// is UNIQUE on (organization_id, correlation_id), so a redelivery never pages twice. The payload carries ids and
// figures only (the patient is an id pointer; the display name is resolved per recipient at render). A malformed
// event, or a scope/band pair with no alert kind, THROWS (retry -> DLQ), never a silently dropped alert.
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_CAP_THRESHOLD_ALERT_CONSUMER = "m36.cap-threshold-alerts" as const;
export const M36_CAP_THRESHOLD_ALERT_EVENT_TYPES = ["m26.cap.threshold_crossed"] as const;

type ScopeFamily = "agency" | "patient" | "inpatient";
const SCOPE_FAMILY: Readonly<Record<string, ScopeFamily>> = {
  agency_aggregate: "agency",
  patient_aggregate: "patient",
  inpatient: "inpatient",
};

/** DB alert-band -> the suffix of the typed alert kind, per scope family. */
const AGGREGATE_BAND_SUFFIX: Readonly<Record<string, string>> = {
  watch_90: "watch_90",
  warn_95: "warn_95",
  breach_100: "breach_100",
};
const INPATIENT_BAND_SUFFIX: Readonly<Record<string, string>> = {
  inpatient_watch_18: "watch_18",
  inpatient_breach_20: "breach",
};

export interface CapThresholdAlertPlan {
  readonly alertEventType: string;
  readonly severity: "warn" | "critical";
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`${M36_CAP_THRESHOLD_ALERT_CONSUMER}: payload has no ${key}`);
  return v;
}

const optionalNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Pure: the alert one delivered threshold_crossed event raises. */
export function planCapThresholdAlert(
  event: Pick<DispatchableOutboxEvent, "eventType" | "payload">,
): CapThresholdAlertPlan {
  if (!(M36_CAP_THRESHOLD_ALERT_EVENT_TYPES as readonly string[]).includes(event.eventType))
    throw new Error(`${M36_CAP_THRESHOLD_ALERT_CONSUMER}: unexpected event ${event.eventType}`);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const scope = requireString(p, "scope");
  const bandTo = requireString(p, "bandTo");
  const capPeriodId = requireString(p, "capPeriodId");
  const eventId = requireString(p, "eventId");
  const family = SCOPE_FAMILY[scope];
  if (!family) throw new Error(`${M36_CAP_THRESHOLD_ALERT_CONSUMER}: unknown scope ${scope}`);
  const suffix = (family === "inpatient" ? INPATIENT_BAND_SUFFIX : AGGREGATE_BAND_SUFFIX)[bandTo];
  if (!suffix)
    throw new Error(
      `${M36_CAP_THRESHOLD_ALERT_CONSUMER}: no alert kind for ${scope} band ${bandTo}`,
    );
  const patientId = typeof p.patientId === "string" && p.patientId.length > 0 ? p.patientId : null;
  if (family === "patient" && patientId === null)
    throw new Error(`${M36_CAP_THRESHOLD_ALERT_CONSUMER}: patient-scope event has no patientId`);
  const pctOfCap = optionalNumber(p.pctOfCap);
  const paidYtdCents = optionalNumber(p.paidYtdCents);
  const capAmountCents = optionalNumber(p.capAmountCents);
  return {
    alertEventType: `m26.cap.${family}_${suffix}`,
    severity: suffix.startsWith("breach") ? "critical" : "warn",
    correlationKey: eventId,
    safe: {
      capPeriodId,
      ...(typeof p.capYear === "string" ? { capYear: p.capYear } : {}),
      scope,
      bandFrom: requireString(p, "bandFrom"),
      bandTo,
      ...(patientId ? { patientId } : {}),
      ...(pctOfCap !== undefined ? { utilizationPct: Math.round(pctOfCap * 10_000) / 100 } : {}),
      ...(paidYtdCents !== undefined ? { paidToDate: String(paidYtdCents) } : {}),
      ...(capAmountCents !== undefined ? { allocatedCap: String(capAmountCents) } : {}),
      dashboardUrl: `/cap/periods/${capPeriodId}`,
    },
  };
}

export function buildM36CapThresholdAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_CAP_THRESHOLD_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_CAP_THRESHOLD_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planCapThresholdAlert(event);
      await alerts.emit(event.organizationId, {
        eventType: plan.alertEventType,
        severity: plan.severity,
        correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
        payload: { eventType: event.eventType, ...plan.safe },
      });
    },
  };
}
