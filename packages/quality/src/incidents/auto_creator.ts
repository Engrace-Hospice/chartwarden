import type { schema } from "@wardenx/db";
// @wardenx/quality — M30 §4.10 / D8 auto-incident creation from upstream events (P2a). PURE.
//
// Some incidents are not hand-filed: an upstream module's typed outbox event (a reported medication error,
// an expired-unsigned verbal order) mints a `draft` `incident_report` row automatically. Per architecture
// v0.11 §7 (outbox-only cross-module communication, ADR-0011 / ARCH-272) there is NO synchronous cross-
// module call into R-51 — M30 SUBSCRIBES to the upstream event and this PURE function maps the event
// payload to the row to insert. No DB, no clock: the consumer (a later phase) injects `occurredAt`,
// `reportedByMembershipId` (the M30 service membership), and the `triggeringEventOutboxId` (the §2.6
// idempotency backstop on `incident_report.triggering_event_outbox_id`), then persists what we return.
import { WardenXError } from "@wardenx/types";
import { INCIDENT_KIND_CATALOG } from "./kinds";

/** Fields every upstream trigger carries (resolved by the consumer from the inbound event + envelope). */
interface IncidentTriggerBase {
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** When the underlying safety event occurred (the partition key on `incident_report`). */
  readonly occurredAt: Date;
  /** The §2.6 idempotency backstop: the outbox-event id that triggered this auto-creation. */
  readonly triggeringEventOutboxId: string;
  /** The M30 service membership recorded as the reporter of the auto-created draft. */
  readonly reportedByMembershipId: string;
  /** The affected patient, when the upstream event is patient-bound (nullable for staff/visitor events). */
  readonly patientId?: string;
  /** The location the event is attributed to (nullable per the ARCH-011 three-column rule). */
  readonly locationId?: string;
}

/**
 * The upstream events M30 maps to an auto-created incident draft. Discriminated by the source event name
 * so a new trigger is an additive case (the M11 KIND_CATALOG / M22 render-variant precedent).
 */
export type IncidentTriggerEvent =
  | (IncidentTriggerBase & {
      readonly type: "m12.medication.error_reported";
      /** WF-14 — the offending medication order (resolved against M12 at the route layer). */
      readonly medicationOrderId: string;
      /** Optional one-line summary the upstream module supplied (free-text; §3.6 denylisted on persist). */
      readonly summary?: string;
    })
  | (IncidentTriggerBase & {
      readonly type: "m11.order.verbal_expired_unsigned";
      /** The verbal order that lapsed without a counter-signature (a §2.3 safety event). */
      readonly orderId: string;
      readonly summary?: string;
    })
  | (IncidentTriggerBase & {
      readonly type: "m37.restraint.applied";
      /** F-185 (#248) — the thin-pointer design: M30 never widens M37's payload or reads M37's
       *  audit-denylisted `restraint_justification_text`; the draft carries only the restraint event's
       *  id and kind, plus an auto-generated narrativeText (below). */
      readonly restraintEventId: string;
      readonly restraintKind: string;
      readonly summary?: string;
    });

/** A machine-readable failure when an unmapped event reaches the auto-creator. */
export const M30_AUTO_INCIDENT_ERROR_STATUS = {
  UNSUPPORTED_INCIDENT_TRIGGER: 422,
} as const;

/** Throw when an upstream event has no incident mapping (defensive — the consumer registry should prevent it). */
function unsupportedTrigger(eventType: string): never {
  throw new WardenXError(
    "UNSUPPORTED_INCIDENT_TRIGGER",
    `no auto-incident mapping for upstream event '${eventType}'`,
    M30_AUTO_INCIDENT_ERROR_STATUS.UNSUPPORTED_INCIDENT_TRIGGER,
  );
}

/**
 * Map an upstream trigger event to the `incident_report` `draft` row to insert (PURE). The returned row is
 * a `NewIncidentReport` (`$inferInsert`): `lifecycle` opens at `draft`, `severity` defaults to the kind's
 * catalog default (raisable at triage), `mandatoryReportFlag` stays `false` (the V-15 gate is evaluated at
 * `submit`, not at auto-draft), and `triggeringEventOutboxId` carries the §2.6 idempotency key. The
 * consumer persists this inside the inbound-event transaction; the partial-UNIQUE on
 * `triggering_event_outbox_id` makes a redelivery a no-op.
 */
export function buildIncidentDraftFromEvent(event: IncidentTriggerEvent): schema.NewIncidentReport {
  const base = {
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    occurredAt: event.occurredAt,
    reportedByMembershipId: event.reportedByMembershipId,
    lifecycle: "draft" as const,
    mandatoryReportFlag: false,
    triggeringEventOutboxId: event.triggeringEventOutboxId,
    ...(event.patientId !== undefined ? { patientId: event.patientId } : {}),
    ...(event.locationId !== undefined ? { locationId: event.locationId } : {}),
  };

  switch (event.type) {
    case "m12.medication.error_reported": {
      const kindData: schema.IncidentKindData = {
        medicationOrderId: event.medicationOrderId,
        narrativeText:
          event.summary ?? "Medication error reported by the medication-administration surface.",
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
      return {
        ...base,
        kind: "medication_error",
        severity: INCIDENT_KIND_CATALOG.medication_error.defaultSeverity,
        kindData,
      };
    }

    case "m11.order.verbal_expired_unsigned": {
      const kindData: schema.IncidentKindData = {
        relatedOrderId: event.orderId,
        narrativeText:
          event.summary ??
          "A verbal order expired without the required counter-signature within the verbal window.",
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
      return {
        ...base,
        kind: "other_safety_event",
        severity: INCIDENT_KIND_CATALOG.other_safety_event.defaultSeverity,
        kindData,
      };
    }

    case "m37.restraint.applied": {
      const kindData: schema.IncidentKindData = {
        restraintEventId: event.restraintEventId,
        restraintKind: event.restraintKind,
        narrativeText:
          event.summary ?? "Restraint applied; see IPU restraint record for clinical detail.",
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
      return {
        ...base,
        kind: "restraint_use",
        severity: INCIDENT_KIND_CATALOG.restraint_use.defaultSeverity,
        kindData,
      };
    }

    default:
      // Exhaustiveness backstop — TS narrows `event` to `never` here when the union is fully handled.
      return unsupportedTrigger((event as { type: string }).type);
  }
}
