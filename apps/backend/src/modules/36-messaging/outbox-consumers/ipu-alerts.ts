// apps/backend/src/modules/36-messaging/outbox-consumers/ipu-alerts.ts — M36's consumer of M37's §4.8 watchdog
// events (GAP-105). M37 spec §4.9 names these as typed M36 alerts; until now the events were published by
// nothing (the crons were never built) and consumed by nothing (M36 sat on the seam-consumer list).
//
//   event (M37 outbox)                    -> alert eventType (platform `alert_rule`)   severity
//   m37.irc_episode.cap_approaching       -> m37.irc_episode.cap_approaching            warn
//   m37.irc_episode.cap_breached          -> m37.irc_episode.cap_breached               critical (spec: block)
//   m37.restraint.reassessment_due        -> m37.restraint.reassessment_due             warn
//   m37.bed.cleaning_overdue              -> m37.bed.cleaning_overdue                   warn
//   m37.gip_criteria.reassessment_due     -> m37.gip_criteria.reassessment_due          warn
//   m37.shift.rn_uncovered                -> m37.shift.rn_uncovered                     critical (spec: block)
//   m37.shift.coverage_gap_projected      -> m37.shift.coverage_gap_projected           warn
//   m37.equipment.inspection_due          -> m37.equipment.inspection_due               warn
//   m37.equipment.inspection_overdue      -> m37.equipment.inspection_overdue           critical (spec: block)
//   m37.nursing_note.shift_overdue        -> m37.nursing_note.shift_overdue             warn
//   m37.bed.reservation_expired           -> m37.bed.reservation_expired                warn
//   m37.ipu_admission.transfer_unconfirmed -> m37.ipu_admission.transfer_unconfirmed    warn
//
// RECIPIENTS: each alert type has a platform `alert_rule` (packages/messaging seed) resolving a `role_set`
// — an IPU alert is about a unit/admission, not a patient care team, and the payloads carry no patient id
// (PHI-lean by construction). M36 never imports M37; events are matched by name.
//
// IDEMPOTENCY: every alert has a deterministic correlation id and `alert` is UNIQUE on
// (organization_id, correlation_id), so a relay redelivery, a cron retry or the second tick a nag window can
// catch never pages twice; a NEW nag cycle / day / day-count is a new key, which is the intended re-raise.
//
// NO PHI: ids, instants and counts only. A malformed event THROWS (relay retry -> DLQ — a visible failure,
// never a silently dropped alert).
import type { AlertEmitter, AlertSeverity } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_IPU_ALERT_CONSUMER = "m36.ipu-alerts" as const;

export const M36_IPU_ALERT_EVENT_TYPES = [
  "m37.irc_episode.cap_approaching",
  "m37.irc_episode.cap_breached",
  "m37.restraint.reassessment_due",
  "m37.bed.cleaning_overdue",
  "m37.gip_criteria.reassessment_due",
  "m37.shift.rn_uncovered",
  "m37.shift.coverage_gap_projected",
  "m37.equipment.inspection_due",
  "m37.equipment.inspection_overdue",
  "m37.nursing_note.shift_overdue",
  "m37.bed.reservation_expired",
  "m37.ipu_admission.transfer_unconfirmed",
] as const;

interface IpuAlertPlan {
  readonly severity: AlertSeverity;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_IPU_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

function requireNumber(p: Record<string, unknown>, key: string, eventName: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${M36_IPU_ALERT_CONSUMER}: ${eventName} payload has no numeric ${key}`);
  }
  return v;
}

function planFor(event: DispatchableOutboxEvent): IpuAlertPlan {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  switch (name) {
    case "m37.irc_episode.cap_approaching":
    case "m37.irc_episode.cap_breached": {
      const ipuAdmissionId = requireString(p, "ipuAdmissionId", name);
      const consecutiveDayCount = requireNumber(p, "consecutiveDayCount", name);
      const breached = name === "m37.irc_episode.cap_breached";
      return {
        severity: breached ? "critical" : "warn",
        correlationKey: `${ipuAdmissionId}:${consecutiveDayCount}`,
        safe: {
          ipuAdmissionId,
          consecutiveDayCount,
          deepLink: `/ipu/admissions/${ipuAdmissionId}`,
          message: breached
            ? "An inpatient respite stay has reached the 5-day cap; per-diem billing is blocked until it ends or an override is granted."
            : "An inpatient respite stay is on its last day before the 5-day cap.",
        },
      };
    }
    case "m37.restraint.reassessment_due": {
      const restraintEventId = requireString(p, "restraintEventId", name);
      const cycle = typeof p.reminderCycle === "number" ? p.reminderCycle : 0;
      return {
        severity: "warn",
        correlationKey: `${restraintEventId}:${cycle}`,
        safe: {
          restraintEventId,
          ipuAdmissionId: p.ipuAdmissionId,
          dueAt: p.dueAt,
          reminderCycle: cycle,
          deepLink: p.ipuAdmissionId ? `/ipu/admissions/${String(p.ipuAdmissionId)}` : "/ipu",
          message: "An active restraint is past its reassessment interval.",
        },
      };
    }
    case "m37.bed.cleaning_overdue": {
      const bedId = requireString(p, "bedId", name);
      const cycle = typeof p.reminderCycle === "number" ? p.reminderCycle : 0;
      return {
        severity: "warn",
        correlationKey: `${bedId}:${String(p.dischargedDirtyAt ?? "")}:${cycle}`,
        safe: {
          bedId,
          unitId: p.unitId,
          dischargedDirtyAt: p.dischargedDirtyAt,
          slaMinutes: p.slaMinutes,
          reminderCycle: cycle,
          deepLink: "/ipu/beds",
          message: "A bed has exceeded its turnover SLA and is not ready.",
        },
      };
    }
    case "m37.gip_criteria.reassessment_due": {
      const ipuAdmissionId = requireString(p, "ipuAdmissionId", name);
      return {
        severity: "warn",
        // One per admission per sweep date. The encounter-driven path (no sweepDate) keys on the encounter.
        correlationKey: `${ipuAdmissionId}:${String(p.sweepDate ?? p.triggeredByEncounterId ?? "")}`,
        safe: {
          ipuAdmissionId,
          lastAssessedAt: p.lastAssessedAt,
          staleHours: p.staleHours,
          deepLink: `/ipu/admissions/${ipuAdmissionId}`,
          message: "A general-inpatient admission is due for criteria reassessment.",
        },
      };
    }
    case "m37.shift.rn_uncovered": {
      const unitId = requireString(p, "unitId", name);
      const hourStartAt = requireString(p, "hourStartAt", name);
      return {
        // The spec's block-severity alert (`critical` on the legacy ladder): no RN on shift this hour.
        severity: "critical",
        // One per unit per uncovered hour: the 5-minute watchdog re-publishes it every tick of that hour.
        correlationKey: `${unitId}:${hourStartAt}`,
        safe: {
          unitId,
          hourStartAt,
          deepLink: "/ipu",
          message:
            "No RN is on shift for this inpatient unit this hour; admissions, transfers and restraints are blocked until coverage is restored.",
        },
      };
    }
    case "m37.shift.coverage_gap_projected": {
      const unitId = requireString(p, "unitId", name);
      const gapStartsAt = requireString(p, "gapStartsAt", name);
      return {
        severity: "warn",
        correlationKey: `${unitId}:${gapStartsAt}`,
        safe: {
          unitId,
          gapStartsAt,
          alertHorizonHours: p.alertHorizonHours,
          deepLink: "/ipu",
          message: "An inpatient unit has an RN-coverage gap coming up within the alert horizon.",
        },
      };
    }
    case "m37.equipment.inspection_due": {
      const equipmentId = requireString(p, "equipmentId", name);
      const daysUntilDue = requireNumber(p, "daysUntilDue", name);
      return {
        severity: "warn",
        correlationKey: `${equipmentId}:${String(p.dueDate ?? "")}:${daysUntilDue}`,
        safe: {
          equipmentId,
          dueDate: p.dueDate,
          daysUntilDue,
          deepLink: "/ipu/equipment",
          message: "An equipment biomed inspection is coming due.",
        },
      };
    }
    case "m37.equipment.inspection_overdue": {
      const equipmentId = requireString(p, "equipmentId", name);
      const daysOverdue = typeof p.daysOverdue === "number" ? p.daysOverdue : 1;
      return {
        severity: "critical",
        correlationKey: `${equipmentId}:${String(p.dueDate ?? "")}:${daysOverdue}`,
        safe: {
          equipmentId,
          dueDate: p.dueDate,
          daysOverdue,
          deepLink: "/ipu/equipment",
          message:
            "An equipment biomed inspection is overdue; the item cannot be assigned to a patient until re-inspected.",
        },
      };
    }
    case "m37.nursing_note.shift_overdue": {
      const ipuAdmissionId = requireString(p, "ipuAdmissionId", name);
      const shiftId = requireString(p, "shiftId", name);
      return {
        severity: "warn",
        correlationKey: `${shiftId}:${ipuAdmissionId}`,
        safe: {
          ipuAdmissionId,
          shiftId,
          shiftEndAt: p.shiftEndAt,
          deepLink: `/ipu/admissions/${ipuAdmissionId}`,
          message:
            "No q-shift nursing note was signed for an inpatient on the shift that just ended.",
        },
      };
    }
    case "m37.bed.reservation_expired": {
      const bedId = requireString(p, "bedId", name);
      const reservedAt = requireString(p, "reservedAt", name);
      return {
        severity: "warn",
        correlationKey: `${bedId}:${reservedAt}`,
        safe: {
          bedId,
          unitId: p.unitId,
          ipuAdmissionId: p.ipuAdmissionId,
          reservedAt,
          deepLink: "/ipu/beds",
          message:
            "A bed reservation lapsed after 4 hours and was released; the admission is waiting for a bed again.",
        },
      };
    }
    case "m37.ipu_admission.transfer_unconfirmed": {
      const ipuAdmissionId = requireString(p, "ipuAdmissionId", name);
      const cycle = typeof p.reminderCycle === "number" ? p.reminderCycle : 0;
      return {
        severity: "warn",
        correlationKey: `${ipuAdmissionId}:${cycle}`,
        safe: {
          ipuAdmissionId,
          initiatedAt: p.initiatedAt,
          reminderCycle: cycle,
          deepLink: `/ipu/admissions/${ipuAdmissionId}`,
          message: "An inpatient transfer has not been confirmed within an hour of starting.",
        },
      };
    }
    default:
      throw new Error(`${M36_IPU_ALERT_CONSUMER}: unexpected event ${name}`);
  }
}

export function buildM36IpuAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_IPU_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_IPU_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planFor(event);
      await alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: plan.severity,
        correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
        payload: { eventType: event.eventType, ...plan.safe },
      });
    },
  };
}

export { planFor as planIpuAlert };
