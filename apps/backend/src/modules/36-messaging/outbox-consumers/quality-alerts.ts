// apps/backend/src/modules/36-messaging/outbox-consumers/quality-alerts.ts — M36's consumer of M30's quality
// events (GAP-049). M30's catalog descriptions say "M36 raises the §4.9 alert" but no consumer was bound
// (`declaredConsumers: []`), so a sentinel or abuse-allegation incident, an infection outbreak, a QAPI
// threshold breach and a CAHPS sample all raised nothing.
//
//   event (M30 outbox)                  -> alert eventType (platform `alert_rule`)       severity
//   m30.incident.submitted (critical)   -> m30.alerts.incident_sentinel                   critical
//   m30.incident.submitted (abuse)      -> m30.alerts.incident_abuse_allegation           critical
//   m30.infection.outbreak_opened       -> m30.alerts.outbreak_detected                   warn
//   m30.measure.threshold_breached      -> m30.alerts.measure_threshold_breached          warn
//   m30.cahps.sample_ready              -> m30.alerts.cahps_sample_ready                  info
//
// A submitted incident that is neither critical-severity ("sentinel", spec §4.9) nor an abuse allegation raises
// nothing here. One submitted event can raise BOTH incident alerts (a critical abuse allegation).
//
// RECIPIENTS: each alert type has a platform `alert_rule` (packages/messaging seed) resolving a `role_set`.
// M36 never imports M30 — events are matched by name.
// TENANT: from the envelope `event.organizationId`, NEVER the payload `orgId` (informational copy only).
// IDEMPOTENCY: every alert has a deterministic correlation id and `alert` is UNIQUE on (organization_id,
// correlation_id), so a relay redelivery never pages twice.
// NO PHI: ids, enums, counts and instants only. A malformed event THROWS (relay retry -> DLQ — a visible
// failure, never a silently dropped safety page).
import type { AlertEmitter, AlertSeverity } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_QUALITY_ALERT_CONSUMER = "m36.quality-alerts" as const;

export const M36_QUALITY_ALERT_EVENT_TYPES = [
  "m30.incident.submitted",
  "m30.infection.outbreak_opened",
  "m30.measure.threshold_breached",
  "m30.cahps.sample_ready",
] as const;

/** The incident severity the spec calls a "sentinel" event (`m30_incident_severity`). */
const SENTINEL_SEVERITY = "critical";
/** The incident kind that raises the abuse-allegation alert (`m30_incident_kind`). */
const ABUSE_KIND = "allegation_of_abuse";

export interface QualityAlertPlan {
  readonly alertType: string;
  readonly severity: AlertSeverity;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_QUALITY_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

function incidentPlans(name: string, p: Record<string, unknown>): QualityAlertPlan[] {
  const incidentId = requireString(p, "incidentId", name);
  const kind = requireString(p, "kind", name);
  const severity = requireString(p, "severity", name);
  const reportedAt = requireString(p, "reportedAt", name);
  const safe = {
    incidentId,
    kind,
    severity,
    reportedAt,
    deepLink: `/quality/incidents/${incidentId}`,
  };
  const plans: QualityAlertPlan[] = [];
  if (severity === SENTINEL_SEVERITY) {
    plans.push({
      alertType: "m30.alerts.incident_sentinel",
      severity: "critical",
      correlationKey: incidentId,
      safe: { ...safe, message: "A sentinel-severity incident was submitted." },
    });
  }
  if (kind === ABUSE_KIND) {
    plans.push({
      alertType: "m30.alerts.incident_abuse_allegation",
      severity: "critical",
      correlationKey: incidentId,
      safe: { ...safe, message: "An abuse-allegation incident was submitted." },
    });
  }
  return plans;
}

/** The alerts one M30 event raises (zero for a non-sentinel, non-abuse incident). Throws on a malformed payload. */
export function planQualityAlerts(event: DispatchableOutboxEvent): readonly QualityAlertPlan[] {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  switch (name) {
    case "m30.incident.submitted":
      return incidentPlans(name, p);
    case "m30.infection.outbreak_opened": {
      const caseId = requireString(p, "caseId", name);
      return [
        {
          alertType: "m30.alerts.outbreak_detected",
          severity: "warn",
          correlationKey: caseId,
          safe: {
            caseId,
            pathogen: requireString(p, "pathogen", name),
            bodySite: requireString(p, "bodySite", name),
            eventCount: p.eventCount,
            firstEventAt: p.firstEventAt,
            lastEventAt: p.lastEventAt,
            deepLink: "/quality/infection",
            message: "An infection cluster crossed the outbreak threshold.",
          },
        },
      ];
    }
    case "m30.measure.threshold_breached": {
      const indicatorId = requireString(p, "indicatorId", name);
      const periodEnd = requireString(p, "periodEnd", name);
      return [
        {
          alertType: "m30.alerts.measure_threshold_breached",
          severity: "warn",
          correlationKey: `${indicatorId}:${periodEnd}`,
          safe: {
            indicatorId,
            measureId: requireString(p, "measureId", name),
            periodEnd,
            rate: p.rate,
            threshold: p.threshold,
            severityBand: p.severityBand,
            deepLink: "/quality/qapi",
            message: "A QAPI indicator crossed its threshold.",
          },
        },
      ];
    }
    case "m30.cahps.sample_ready": {
      const period = (p.samplePeriod ?? {}) as Record<string, unknown>;
      const start = requireString(period, "start", name);
      const end = requireString(period, "end", name);
      return [
        {
          alertType: "m30.alerts.cahps_sample_ready",
          severity: "info",
          correlationKey: `${start}:${end}`,
          safe: {
            samplePeriod: { start, end },
            decedentCount: p.decedentCount,
            vendor: p.vendor,
            deepLink: "/quality/cahps",
            message: "The monthly CAHPS decedent sample is ready for export.",
          },
        },
      ];
    }
    default:
      throw new Error(`${M36_QUALITY_ALERT_CONSUMER}: unexpected event ${name}`);
  }
}

export function buildM36QualityAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_QUALITY_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_QUALITY_ALERT_EVENT_TYPES,
    async handle(event) {
      for (const plan of planQualityAlerts(event)) {
        await alerts.emit(event.organizationId, {
          eventType: plan.alertType,
          severity: plan.severity,
          correlationId: `outbox:${plan.alertType}:${plan.correlationKey}`,
          payload: { eventType: plan.alertType, ...plan.safe },
        });
      }
    },
  };
}
