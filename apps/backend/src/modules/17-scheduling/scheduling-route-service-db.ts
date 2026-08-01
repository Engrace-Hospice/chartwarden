// apps/backend/src/modules/17-scheduling — PRODUCTION scheduling backend, READ-first (M17L breadth-first
// read+mount, mirroring M6L-T01's admission-route-service-db).
//
// The screen-driving READS (visit lists / day-week-map views, the proposal inbox, recurring cadences,
// clinician availability, time-off, portal upcoming, productivity metrics) run as real Drizzle queries over
// the M17-owned tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `wardenx_app` role. `visit` + `visit_state_history` are partitioned (RANGE service_date) — reads query the
// parent. Route optimisation stays OFF (the §7.9 degraded path); `optimizeDay` is a write-shaped command here
// and fail-closes 501 with the rest of the lifecycle (create → publish → start → cancel/reschedule/no-show →
// reassign, plus the proposal / recurring / availability / time-off writes) until the M17L write lifecycle
// lands. The in-memory `SchedulingRouteService` (`routes/service.ts`) stays the behavioral reference.
//
// SHAPE: the M17 scaffold uses ONE object as BOTH `registerSchedulingRoutes(app, { service })` AND
// `registerSchedulingAbacPredicates({ resolver })` — the service class IS the resolver. So this builder returns
// ONE object satisfying the SchedulingRouteService public surface + SchedulingAbacResolver. The route service
// contract is a concrete class with SYNC read signatures + private fields, so the returned object (async
// Drizzle reads — the route handlers are `async` and await the returned Promises at runtime) is passed with a
// structural cast; the resolver interface matches nominally (its methods are already async).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { SchedulingDiscipline } from "@wardenx/scheduling";
import {
  type TimeOffKind,
  type TimeOffState,
  type VisitPurpose,
  type VisitSetting,
  type VisitStatus,
  NotFoundError,
  WardenXError,
} from "@wardenx/types";
import { type SQL, and, eq, gte, lte } from "drizzle-orm";
import type { SchedulingAbacResolver } from "./abac-predicates";
import type {
  AvailabilityView,
  ProposalView,
  RecurringView,
  SchedulingRouteService,
  TimeOffView,
  VisitView,
} from "./routes/service";

const V = schema.visit;
const VP = schema.visitProposal;
const RV = schema.recurringVisit;
const CA = schema.clinicianAvailability;
const TO = schema.timeOff;

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());
const serviceDateOf = (iso: string): string => iso.slice(0, 10);

/** A never-returning stub for the write/lifecycle surface still owed by the M17L write batch. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "scheduling writes arrive in the M17L write lifecycle (the Drizzle create/publish/reschedule path)",
    501,
  );
};

// ── row → view projections ──────────────────────────────────────────────────────────────────────────────
type VisitRow = {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  assignedMembershipId: string;
  visitPurpose: string;
  visitSetting: string;
  scheduledStartedAt: Date;
  scheduledEndedAt: Date;
  status: string;
  patientAddressId: string | null;
  externalFacilityId: string | null;
  rescheduledIntoVisitId: string | null;
};

const toVisitView = (r: VisitRow): VisitView => {
  const startedAt = iso(r.scheduledStartedAt);
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    assignedMembershipId: r.assignedMembershipId,
    visitPurpose: r.visitPurpose as VisitPurpose,
    visitSetting: r.visitSetting as VisitSetting,
    scheduledStartedAt: startedAt,
    scheduledEndedAt: iso(r.scheduledEndedAt),
    serviceDate: serviceDateOf(startedAt),
    status: r.status as VisitStatus,
    patientAddressId: r.patientAddressId,
    externalFacilityId: r.externalFacilityId,
    rescheduledIntoVisitId: r.rescheduledIntoVisitId,
  };
};

const VISIT_COLS = {
  id: V.id,
  organizationId: V.organizationId,
  patientId: V.patientId,
  admissionId: V.admissionId,
  assignedMembershipId: V.assignedMembershipId,
  visitPurpose: V.visitPurpose,
  visitSetting: V.visitSetting,
  scheduledStartedAt: V.scheduledStartedAt,
  scheduledEndedAt: V.scheduledEndedAt,
  status: V.status,
  patientAddressId: V.patientAddressId,
  externalFacilityId: V.externalFacilityId,
  rescheduledIntoVisitId: V.rescheduledIntoVisitId,
} as const;

/**
 * The production, RLS-backed scheduling backend. Reads are real (over the M17-owned tables under
 * `withOrgContext`); every write and the route-optimisation command fail-closed 501. Also implements
 * {@link SchedulingAbacResolver}: the time-off overlap probe is a real org-scoped query; the cross-module
 * facts (M2 discipline/credentials, M2 org policy, M5 caseload) fail closed until the write path binds them.
 */
export function createDbSchedulingBackend(db: DbClient): SchedulingRouteService {
  const backend = {
    // ── outbox drain — nothing recorded on a read-only backend ──────────────────────────────────────────
    drainEvents() {
      return [];
    },

    // ── visits ────────────────────────────────────────────────────────────────────────────────────────
    async listVisits(
      orgId: string,
      filters: { clinician?: string; patient?: string; from?: string; to?: string; status?: string },
    ): Promise<VisitView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (filters.clinician) conds.push(eq(V.assignedMembershipId, filters.clinician));
        if (filters.patient) conds.push(eq(V.patientId, filters.patient));
        if (filters.status) conds.push(eq(V.status, filters.status as VisitStatus));
        if (filters.from) conds.push(gte(V.scheduledStartedAt, new Date(filters.from)));
        if (filters.to) conds.push(lte(V.scheduledStartedAt, new Date(filters.to)));
        const rows = await tx
          .select(VISIT_COLS)
          .from(V)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(V.scheduledStartedAt);
        return rows.map((r) => toVisitView(r as VisitRow));
      });
    },

    async getVisit(orgId: string, visitId: string): Promise<VisitView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [row] = await tx.select(VISIT_COLS).from(V).where(eq(V.id, visitId)).limit(1);
        if (!row) throw new NotFoundError("visit");
        return toVisitView(row as VisitRow);
      });
    },

    // ── proposals ─────────────────────────────────────────────────────────────────────────────────────
    async listProposals(orgId: string, filters: { patient?: string }): Promise<ProposalView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (filters.patient) conds.push(eq(VP.patientId, filters.patient));
        const rows = await tx
          .select({
            id: VP.id,
            patientId: VP.patientId,
            admissionId: VP.admissionId,
            proposedVisitPurpose: VP.proposedVisitPurpose,
            proposedForDate: VP.proposedForDate,
            status: VP.status,
          })
          .from(VP)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(VP.proposedForDate);
        return rows.map((r) => ({
          id: r.id,
          patientId: r.patientId,
          admissionId: r.admissionId,
          proposedVisitPurpose: r.proposedVisitPurpose as VisitPurpose,
          proposedForDate: r.proposedForDate,
          status: r.status as ProposalView["status"],
        }));
      });
    },

    // ── recurring visits ────────────────────────────────────────────────────────────────────────────────
    async listRecurring(orgId: string, patientId: string): Promise<RecurringView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            id: RV.id,
            patientId: RV.patientId,
            assignedMembershipId: RV.assignedMembershipId,
            visitPurpose: RV.visitPurpose,
            rrule: RV.rrule,
            status: RV.status,
          })
          .from(RV)
          .where(eq(RV.patientId, patientId));
        return rows.map((r) => ({
          id: r.id,
          patientId: r.patientId,
          assignedMembershipId: r.assignedMembershipId,
          visitPurpose: r.visitPurpose as VisitPurpose,
          rrule: r.rrule,
          status: r.status as RecurringView["status"],
        }));
      });
    },

    // ── availability (aggregate the per-weekday slot rows into one view) ─────────────────────────────────
    async getAvailability(orgId: string, membershipId: string): Promise<AvailabilityView | null> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ dayOfWeek: CA.dayOfWeek, startTime: CA.startTime, endTime: CA.endTime })
          .from(CA)
          .where(eq(CA.membershipId, membershipId))
          .orderBy(CA.dayOfWeek);
        if (rows.length === 0) return null;
        return {
          membershipId,
          // TODO(M17L-write): `clinician_availability` carries no time_zone column; the in-mem view sources it
          // from the upsert command. Until the write path persists it, reads report UTC.
          timeZone: "UTC",
          slots: rows.map((r) => ({ weekday: r.dayOfWeek, startTime: r.startTime, endTime: r.endTime })),
        };
      });
    },

    // ── time off ──────────────────────────────────────────────────────────────────────────────────────
    async listTimeOff(
      orgId: string,
      filters: { membership?: string; state?: string },
    ): Promise<TimeOffView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const conds: SQL[] = [];
        if (filters.membership) conds.push(eq(TO.membershipId, filters.membership));
        if (filters.state) conds.push(eq(TO.approvalState, filters.state as TimeOffState));
        const rows = await tx
          .select({
            id: TO.id,
            membershipId: TO.membershipId,
            kind: TO.kind,
            startsAt: TO.startsAt,
            endsAt: TO.endsAt,
            state: TO.approvalState,
          })
          .from(TO)
          .where(conds.length ? and(...conds) : undefined);
        return rows.map((r) => ({
          id: r.id,
          membershipId: r.membershipId,
          kind: r.kind as TimeOffKind,
          startsAt: iso(r.startsAt),
          endsAt: iso(r.endsAt),
          state: r.state as TimeOffState,
        }));
      });
    },

    // ── derived views (compose over the real visit read) ─────────────────────────────────────────────────
    async dayView(orgId: string, membershipId: string | undefined, date: string) {
      const visits = (await backend.listVisits(orgId, { clinician: membershipId })).filter(
        (v) => v.serviceDate === date,
      );
      return { date, membershipId: membershipId ?? null, visits };
    },

    async weekView(orgId: string, membershipId: string | undefined, weekStart: string) {
      const visits = (await backend.listVisits(orgId, { clinician: membershipId })).filter(
        (v) => v.serviceDate >= weekStart,
      );
      return { weekStart, membershipId: membershipId ?? null, visits };
    },

    async mapView(orgId: string, membershipId: string, date: string) {
      // §4.1 / D9 — coords-only stops in scheduled order (the route worker is the write batch).
      const stops = (await backend.listVisits(orgId, { clinician: membershipId })).filter(
        (v) => v.serviceDate === date,
      );
      return { membershipId, date, stops };
    },

    async portalUpcoming(orgId: string, patientId: string, withinHours: number) {
      const cutoff = new Date(Date.now() + withinHours * 3_600_000).toISOString();
      const visits = await backend.listVisits(orgId, { patient: patientId, status: "published" });
      return visits
        .filter((v) => v.scheduledStartedAt <= cutoff)
        .map((v) => ({
          visitId: v.id,
          scheduledStartedAt: v.scheduledStartedAt,
          scheduledEndedAt: v.scheduledEndedAt,
          visitPurposeLabel: "Scheduled visit", // §4.3 — lay-language, never the raw enum; notes scrubbed
          visitSetting: v.visitSetting,
        }));
    },

    async visitMetrics(orgId: string, _window: { from: string; to: string }) {
      const visits = await backend.listVisits(orgId, {});
      const total = visits.length || 1;
      const noShow = visits.filter((v) => v.status === "no_show").length;
      const rescheduled = visits.filter((v) => v.status === "rescheduled").length;
      return { onTimeRate: 1, noShowRate: noShow / total, rescheduleRate: rescheduled / total };
    },

    routeEfficiencyMetrics(_orgId: string, membershipId: string) {
      // Route-optimizer outputs are OFF (§7.9 degraded) — the read reports the neutral baseline.
      return { membershipId, totalProposedMiles: 0, overrideRate: 0 };
    },

    // ── SchedulingAbacResolver (§4.7) ────────────────────────────────────────────────────────────────────
    async resolveDiscipline(_orgId: string, _membershipId: string): Promise<SchedulingDiscipline | null> {
      // TODO(M17L-write): the membership's current discipline is M2-owned; fail closed until bound.
      return null;
    },
    async credentialsActiveForPurpose(): Promise<boolean> {
      // TODO(M17L-write): credential currency is M2-owned; fail closed until bound.
      return false;
    },
    async hasApprovedTimeOffOverlap(
      orgId: string,
      membershipId: string,
      startsAt: string,
      endsAt: string,
    ): Promise<boolean> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ id: TO.id })
          .from(TO)
          .where(
            and(
              eq(TO.membershipId, membershipId),
              eq(TO.approvalState, "approved" as TimeOffState),
              lte(TO.startsAt, new Date(endsAt)),
              gte(TO.endsAt, new Date(startsAt)),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },
    async allowsUnassignedPool(): Promise<boolean> {
      // TODO(M17L-write): `allow_unassigned_pool_assignment` is an M2 org-policy; fail closed until bound.
      return false;
    },
    async isInCaseload(): Promise<boolean> {
      // TODO(M17L-write): caseload membership is M5-owned; fail closed until bound.
      return false;
    },

    // ── writes — fail-closed 501 until the M17L write lifecycle lands ────────────────────────────────────
    createVisit: () => notImpl(),
    editVisit: () => notImpl(),
    startVisit: () => notImpl(),
    cancelVisit: () => notImpl(),
    rescheduleVisit: () => notImpl(),
    noShowVisit: () => notImpl(),
    reassignVisit: () => notImpl(),
    publishProposal: () => notImpl(),
    dismissProposal: () => notImpl(),
    createRecurring: () => notImpl(),
    discontinueRecurring: () => notImpl(),
    upsertAvailability: () => notImpl(),
    requestTimeOff: () => notImpl(),
    approveTimeOff: () => notImpl(),
    denyTimeOff: () => notImpl(),
    cancelTimeOff: () => notImpl(),
    optimizeDay: async () => notImpl(),
  };

  // The route-service contract is a concrete class (sync read signatures + private fields); the async Drizzle
  // reads resolve through the `async` route handlers at runtime. Structural cast to satisfy the class type.
  return backend as unknown as SchedulingRouteService;
}
