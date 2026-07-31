// apps/backend/src/modules/15-discipline-care-plans/volunteer — M15-T04 (§7.4 / §7.5 / §7.6).
//
// The 42 CFR §418.78 volunteer domain: the compliance-gate lifecycle (`gates.ts`), the effective-status
// computation M17's pre-schedule gate consumes through the LOCKED `VolunteerComplianceProvider` seam
// (`effective-status.ts`), the assignment write + expiry-cascade decisions (`assignments.ts`), and the
// 418.78(e) 5% hour ledger + ratio (`hours.ts`).
//
// Every function is pure and deterministic — `now`, the gate rows and the M27 patient-care-hours
// denominator are injected — so the M15-T06 routes and the `volunteer-gate-watcher` /
// `volunteer-hour-aggregator` crons compose them inside one optimistic-locked transaction. Fail-CLOSED
// per §8.7 / M15-F11: an unreadable gate store denies the booking, it never assumes compliance.
export {
  daysUntilExpiry,
  decideExpireGate,
  decideRecordGate,
  decideRevokeGate,
  deriveGateStatus,
  gatesToExpire,
  isGateClearing,
  planGateExpiryAlerts,
  type RecordGateDecision,
  type RecordGateFacts,
  type VolunteerGateExpiryNotice,
  type VolunteerGateFacts,
} from "./gates";
export { GATE_STORE_UNAVAILABLE, effectiveStatusFor, statusEdge } from "./effective-status";
export {
  decideCreateVolunteerAssignment,
  decideInactivateAssignmentsForGate,
  decideReactivateAssignment,
  gateExpiredReason,
  type AssignmentInactivation,
  type CreateVolunteerAssignmentDecision,
  type CreateVolunteerAssignmentFacts,
  type InactivationCascade,
  type OpenVolunteerAssignment,
} from "./assignments";
export {
  aggregateVolunteerHours,
  checkVolunteerHourEntry,
  computeVolunteerHourRatio,
  fiscalYearFor,
  ratioAlertSeverity,
  type VolunteerHourAggregate,
  type VolunteerHourEntryFacts,
  type VolunteerVisitCandidate,
} from "./hours";
