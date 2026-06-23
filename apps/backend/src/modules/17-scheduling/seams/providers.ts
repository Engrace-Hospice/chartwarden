// apps/backend/src/modules/17-scheduling/seams/providers.ts — M17-T05 the §4.3 seam implementations: pure
// orchestration over an injected {@link SchedulingSeamStore}. Each returns the leaf-typed seam interface
// (@wardenx/types) the M1 registry validates and M8/M18/M14/M5/M19/M20/M31/M30/M33 resolve. The providers add NO
// tenant logic — RLS scopes every store read by the consumer's `app.org_id` (§3.6); they project store rows to
// the read DTOs and derive the read-side measures (the §4.3 on-time / no-show / reschedule rates + the
// stability index = 1 − reschedule-rate). All four seams are READ-only — M17 owns the visit lifecycle internally
// and never mutates through a seam. Mirrors the M9/M10/M11/M12/M13/M14 read-seam provider precedents.
import type {
  PortalVisitReader,
  VisitAssignmentReader,
  VisitMetricsProvider,
  VisitReader,
} from "@wardenx/types";
import type { SchedulingSeamStore } from "./store";

/**
 * §4.3 VisitReader over the store — the visit read path M8 (encounter-authoring context — closes M8's
 * visit-seeding inert consumer, M8 D9), M18 (EVV geofence target), M14 (IDG "completed visits since last
 * meeting") consume. Pure projection; RLS pins the tenant.
 */
export function createVisitReader(store: SchedulingSeamStore): VisitReader {
  return {
    async visitForEncounter(_orgId, visitId) {
      return store.visitById(visitId);
    },
    async visitsScheduledForMembershipOnDate(_orgId, membershipId, date) {
      return [...(await store.scheduledVisitsForMembershipOnDate(membershipId, date))];
    },
    async completedVisitsForPatientSince(_orgId, patientId, sinceIso) {
      return [...(await store.completedVisitsForPatientSince(patientId, sinceIso))];
    },
  };
}

/**
 * §4.3 VisitAssignmentReader over the store — the assignment read path M5 (the §4.5 D11 caseload-contribution
 * projection `patientCaseloadProvider` reads), M19 (on-call triage roster), M20 (field-safety supervisor
 * live-awareness) consume. Pure projection; RLS pins the tenant.
 */
export function createVisitAssignmentReader(store: SchedulingSeamStore): VisitAssignmentReader {
  return {
    async activeVisitsForMembershipOnDate(_orgId, membershipId, date) {
      return [...(await store.activeAssignmentsForMembershipOnDate(membershipId, date))];
    },
    async tonightsOnCallRoster(_orgId, asOfIso) {
      return [...(await store.onCallRoster(asOfIso))];
    },
    async currentVisitForClinician(_orgId, membershipId) {
      return store.currentVisitForClinician(membershipId);
    },
  };
}

/**
 * §4.3 PortalVisitReader over the store — the M31 portal upcoming-visit read path (lay-language; the
 * `scheduler_internal_notes` are never in the {@link PortalVisitSummary} projection, so they cannot cross the
 * seam, §4.1 note). Pure projection; RLS pins the tenant.
 */
export function createPortalVisitReader(store: SchedulingSeamStore): PortalVisitReader {
  return {
    async upcomingForPatient(_orgId, patientId, withinHours) {
      return [...(await store.upcomingForPatient(patientId, withinHours))];
    },
  };
}

/**
 * §4.3 VisitMetricsProvider over the store — the M30/M33 productivity + quality measures read path. The store
 * returns the window TALLIES; the provider does the rate math so the semantics (vacuous-window handling +
 * stability = 1 − reschedule-rate) live in ONE pure place. RLS pins the tenant.
 */
export function createVisitMetricsProvider(store: SchedulingSeamStore): VisitMetricsProvider {
  /** reschedule-rate over the window: rescheduled ÷ published; a window with no published visits is vacuously 0. */
  async function rescheduleRate(window: { from: string; to: string }): Promise<number> {
    const counts = await store.metricsCounts(window);
    return counts.publishedCount === 0 ? 0 : counts.rescheduledCount / counts.publishedCount;
  }
  return {
    async getOnTimeVisitRate(_orgId, windowIso, filters) {
      const counts = await store.metricsCounts(windowIso, filters);
      // No scheduled visits → vacuously on-time (no late visit has occurred).
      return counts.totalScheduled === 0 ? 1 : counts.onTimeCount / counts.totalScheduled;
    },
    async getNoShowRate(_orgId, windowIso) {
      const counts = await store.metricsCounts(windowIso);
      // No scheduled visits → no no-shows.
      return counts.totalScheduled === 0 ? 0 : counts.noShowCount / counts.totalScheduled;
    },
    async getRescheduleRate(_orgId, windowIso) {
      return rescheduleRate(windowIso);
    },
    async getRouteEfficiencyForMembership(_orgId, membershipId, windowIso) {
      return store.routeEfficiencyForMembership(membershipId, windowIso);
    },
    async getScheduleStabilityIndex(_orgId, windowIso) {
      return 1 - (await rescheduleRate(windowIso));
    },
  };
}
