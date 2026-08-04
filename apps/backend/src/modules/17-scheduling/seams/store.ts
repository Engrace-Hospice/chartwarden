// apps/backend/src/modules/17-scheduling/seams/store.ts — M17-T05 the data PORT the §4.3 seam providers
// (VisitReader + VisitAssignmentReader + PortalVisitReader + VisitMetricsProvider) compose over, plus an
// in-memory slice for tests / boot-without-DB. The providers (./providers.ts) are pure orchestration over this
// port; production injects a Drizzle-backed store that reads M17's `visit` / `visit_state_history` /
// `route_segment` rows under the CONSUMER's `withOrgContext` — the providers never switch tenants; RLS scopes
// every read by `app.org_id` (§3.6). Mirrors the M9/M10/M11/M12/M13/M14 read-seam store precedents.
//
// All four M17 seams are READ-only (no mutate path — M17 owns the visit lifecycle internally and never writes
// through a seam). Reads project the read-only DTO shapes from @wardenx/types (never Drizzle rows). Visit
// metadata carries NO clinical free-text (the encounter is M8's, the scheduler-internal notes never cross the
// PortalVisitReader projection) — only visit times, ids, and the lay-language portal summary cross.
import type {
  IsoDate,
  IsoInstant,
  MembershipId,
  OnCallRosterEntry,
  PatientId,
  PortalVisitSummary,
  VisitAssignmentDto,
  VisitDto,
  VisitId,
} from "@wardenx/types";

/** The window counts `VisitMetricsProvider` derives its rates from (§4.3): the visit population in a window plus
 * the on-time / no-show / published / rescheduled tallies. The provider does the division so the rate semantics
 * (vacuous-window handling, stability = 1 − reschedule-rate) live in ONE pure place, not the data port. */
export interface SchedulingMetricsCounts {
  /** Visits whose service window falls in range — denominator for on-time / no-show. */
  readonly totalScheduled: number;
  /** Visits that started on or before their scheduled start (a completed/in-progress on-time visit). */
  readonly onTimeCount: number;
  /** Visits that ended in `no_show`. */
  readonly noShowCount: number;
  /** Visits that reached `published` in the window — denominator for reschedule-rate / stability. */
  readonly publishedCount: number;
  /** Visits that moved `published → rescheduled` in the window. */
  readonly rescheduledCount: number;
}

/** The route-efficiency rollup `VisitMetricsProvider.getRouteEfficiencyForMembership` reads (§4.3): proposed vs.
 * actual miles (actual sourced from M8's `MileagePayrollReader` by the Drizzle store, D10) + the override rate
 * (how often the clinician overrode the suggested visit sequence). */
export interface SchedulingRouteEfficiency {
  readonly totalProposedMiles: number;
  readonly totalActualMiles: number;
  readonly overrideRate: number;
}

/**
 * The data port the §4.3 seam providers compose over. Read methods return read-only DTO shapes (never Drizzle
 * rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Reads key on `visitId` /
 * `membershipId` / `patientId` / a window — the org is already pinned by RLS — and return an empty slice / null
 * when the subject has no visible rows under the consumer's tenant.
 */
export interface SchedulingSeamStore {
  // ── visit reads (VisitReader) ──────────────────────────────────────────────────────────────────────────
  visitById(visitId: VisitId): Promise<VisitDto | null>;
  scheduledVisitsForMembershipOnDate(
    membershipId: MembershipId,
    date: IsoDate,
  ): Promise<ReadonlyArray<VisitDto>>;
  completedVisitsForPatientSince(
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<ReadonlyArray<VisitDto>>;
  // ── assignment reads (VisitAssignmentReader) ───────────────────────────────────────────────────────────
  activeAssignmentsForMembershipOnDate(
    membershipId: MembershipId,
    date: IsoDate,
  ): Promise<ReadonlyArray<VisitAssignmentDto>>;
  onCallRoster(asOfIso: IsoInstant): Promise<ReadonlyArray<OnCallRosterEntry>>;
  currentVisitForClinician(membershipId: MembershipId): Promise<VisitDto | null>;
  // ── portal reads (PortalVisitReader) ───────────────────────────────────────────────────────────────────
  upcomingForPatient(
    patientId: PatientId,
    withinHours: number,
  ): Promise<ReadonlyArray<PortalVisitSummary>>;
  // ── metric reads (VisitMetricsProvider) ────────────────────────────────────────────────────────────────
  metricsCounts(
    window: { from: IsoInstant; to: IsoInstant },
    filters?: { discipline?: string },
  ): Promise<SchedulingMetricsCounts>;
  routeEfficiencyForMembership(
    membershipId: MembershipId,
    window: { from: IsoInstant; to: IsoInstant },
  ): Promise<SchedulingRouteEfficiency>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────────────

/** A lay-language portal summary keyed by the patient it belongs to (the upcoming read filters per call). The
 * DTO itself carries no `patientId` — M17's `visit` row links it; the seed keys it for the in-memory filter. */
export interface PortalVisitSeedRow {
  readonly patientId: PatientId;
  readonly summary: PortalVisitSummary;
}

/** A route-efficiency rollup keyed by membership (the by-membership read filters per call). */
export interface RouteEfficiencySeedRow {
  readonly membershipId: MembershipId;
  readonly window: { from: IsoInstant; to: IsoInstant };
  readonly efficiency: SchedulingRouteEfficiency;
}

/** Deterministic, I/O-free seed for the in-memory {@link SchedulingSeamStore} (slice + seam tests). */
export interface SchedulingSeamSeed {
  /** Visit rows the visit/assignment/metric reads project from. */
  readonly visits?: readonly VisitDto[];
  /** On-call roster entries the roster read resolves (filtered by `asOfIso` ∈ [from,to] per call). */
  readonly onCallRoster?: readonly OnCallRosterEntry[];
  /** Lay-language portal summaries, each keyed by its patient (for the upcoming read). */
  readonly portalSummaries?: readonly PortalVisitSeedRow[];
  /** Route-efficiency rollups, each keyed by membership (for the by-membership read). */
  readonly routeEfficiency?: readonly RouteEfficiencySeedRow[];
}

/** Visit statuses that count as a CURRENTLY-active assignment for the §4.5 D11 caseload contribution: the visit
 * is on the clinician's plate today (published or in-flight), not yet a terminal/historical state. */
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["published", "en_route", "in_visit"]);

/** The service date (org-tz `YYYY-MM-DD`) a visit belongs to — M17's `visit.service_date` column; the in-memory
 * slice derives it from the DTO's `serviceDate` directly. */
function visitOnDate(visit: VisitDto, date: IsoDate): boolean {
  return visit.serviceDate === date;
}

/** An in-memory {@link SchedulingSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemorySchedulingSeamStore(seed: SchedulingSeamSeed = {}): {
  store: SchedulingSeamStore;
} {
  const visits = seed.visits ?? [];
  const byId = new Map<VisitId, VisitDto>(visits.map((v) => [v.id, v]));
  const roster = seed.onCallRoster ?? [];
  const portal = seed.portalSummaries ?? [];
  const routeEff = seed.routeEfficiency ?? [];

  return {
    store: {
      async visitById(visitId) {
        return byId.get(visitId) ?? null;
      },
      async scheduledVisitsForMembershipOnDate(membershipId, date) {
        return visits.filter(
          (v) => v.assignedMembershipId === membershipId && visitOnDate(v, date),
        );
      },
      async completedVisitsForPatientSince(patientId, sinceIso) {
        return visits.filter(
          (v) =>
            v.patientId === patientId &&
            v.status === "completed" &&
            v.scheduledStartedAt >= sinceIso,
        );
      },
      async activeAssignmentsForMembershipOnDate(membershipId, date) {
        return visits
          .filter(
            (v) =>
              v.assignedMembershipId === membershipId &&
              visitOnDate(v, date) &&
              ACTIVE_ASSIGNMENT_STATUSES.has(v.status),
          )
          .map((v) => ({
            visitId: v.id,
            patientId: v.patientId,
            assignedMembershipId: v.assignedMembershipId,
            scheduledStartedAt: v.scheduledStartedAt,
            scheduledEndedAt: v.scheduledEndedAt,
            status: v.status,
          }));
      },
      async onCallRoster(asOfIso) {
        return roster.filter((r) => r.fromIso <= asOfIso && asOfIso < r.toIso);
      },
      async currentVisitForClinician(membershipId) {
        return (
          visits.find((v) => v.assignedMembershipId === membershipId && v.status === "in_visit") ??
          null
        );
      },
      async upcomingForPatient(patientId, _withinHours) {
        // The slice's seeded summaries are already window-relevant + lay-language; the Drizzle store applies the
        // `withinHours` bound in SQL (now() … now()+interval). The slice returns the patient's seeded summaries.
        return portal.filter((p) => p.patientId === patientId).map((p) => p.summary);
      },
      async metricsCounts(window, filters) {
        const inWindow = visits.filter(
          (v) =>
            v.scheduledStartedAt >= window.from &&
            v.scheduledStartedAt <= window.to &&
            (filters?.discipline === undefined ||
              v.assignedDisciplineAtAssignment === filters.discipline),
        );
        let onTimeCount = 0;
        let noShowCount = 0;
        let publishedCount = 0;
        let rescheduledCount = 0;
        for (const v of inWindow) {
          if (v.actualStartedAt !== null && v.actualStartedAt <= v.scheduledStartedAt)
            onTimeCount++;
          if (v.status === "no_show") noShowCount++;
          // A visit that reached `published` (it carries a non-null evvBracketState or any non-proposed status):
          // count anything past the proposal stage as "published" for the stability denominator.
          if (v.status !== "proposed") publishedCount++;
          if (v.status === "rescheduled") rescheduledCount++;
        }
        return {
          totalScheduled: inWindow.length,
          onTimeCount,
          noShowCount,
          publishedCount,
          rescheduledCount,
        };
      },
      async routeEfficiencyForMembership(membershipId, window) {
        const row = routeEff.find(
          (r) =>
            r.membershipId === membershipId &&
            r.window.from === window.from &&
            r.window.to === window.to,
        );
        return row?.efficiency ?? { totalProposedMiles: 0, totalActualMiles: 0, overrideRate: 0 };
      },
    },
  };
}
