// apps/backend/src/modules/17-scheduling/routes/service.ts — M17-T07 the §4.1 route service over an in-memory
// backend (the M11-T06 / M12-T08 / M13-T08 / M14-T05 in-mem-slice precedent; Drizzle in prod under
// `withOrgContext` so RLS backstops every read). The service composes the PURE M17 domain (`@wardenx/scheduling`):
// the §2.2.1 visit state machine (`transitionVisit` / `planVisitProposed`) and the §2.3 / §1.1 D8 discipline
// matrix. It ALSO orchestrates the §1.1 D8 seven-predicate pre-schedule gate for the publish / reassign / edit
// write paths (the visit machine takes the already-computed `gatePassed` verdict) by resolving the same facts
// the route-level §4.7 ABAC predicates resolve — so this service ALSO implements {@link SchedulingAbacResolver}
// (the M12/M13/M14 precedent: the backend is both the route service and the ABAC resolver).
//
// Route optimisation stays behind `scheduling.route_optimization` (OFF in Phase 1): `optimizeDay` returns the
// §7.9 degraded result (visits in scheduled order) unless an OSRM `RoutingProvider` is injected AND the flag is
// on. The adapter boundary lives in `@wardenx/routing-client` (the §25.14 mandate).
import type { RoutingProvider } from "@wardenx/routing-client";
import {
  type SchedulingDiscipline,
  VISIT_PURPOSE_DISCIPLINES,
  planVisitProposed,
  transitionVisit,
} from "@wardenx/scheduling";
import type {
  TimeOffKind,
  TimeOffState,
  VisitPurpose,
  VisitSetting,
  VisitStatus,
} from "@wardenx/types";
import { ConflictError, ForbiddenError, NotFoundError } from "@wardenx/types";
import type { SchedulingAbacResolver } from "../abac-predicates";
import type { CredentialDiscipline, CredentialRecord } from "../seams/index";

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope; M17-T08) ─────────────
export interface RecordedSchedulingEvent {
  readonly eventName: string;
  readonly visitId: string | null;
}

// ── view DTOs (the route projections; never the raw Drizzle row) ──────────────────────────────────────────
export interface VisitView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly assignedMembershipId: string;
  readonly visitPurpose: VisitPurpose;
  readonly visitSetting: VisitSetting;
  readonly scheduledStartedAt: string;
  readonly scheduledEndedAt: string;
  readonly serviceDate: string;
  readonly status: VisitStatus;
  readonly patientAddressId: string | null;
  readonly externalFacilityId: string | null;
  readonly rescheduledIntoVisitId: string | null;
}

export interface ProposalView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly proposedVisitPurpose: VisitPurpose;
  readonly proposedForDate: string;
  readonly status: VisitProposalStatusView;
}
type VisitProposalStatusView = "pending" | "published" | "dismissed" | "stale";

export interface RecurringView {
  readonly id: string;
  readonly patientId: string;
  readonly assignedMembershipId: string;
  readonly visitPurpose: VisitPurpose;
  readonly rrule: string;
  readonly status: "active" | "discontinued";
}

export interface AvailabilityView {
  readonly membershipId: string;
  readonly timeZone: string;
  readonly slots: ReadonlyArray<{ weekday: number; startTime: string; endTime: string }>;
}

export interface TimeOffView {
  readonly id: string;
  readonly membershipId: string;
  readonly kind: TimeOffKind;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly state: TimeOffState;
}

// ── command shapes ────────────────────────────────────────────────────────────────────────────────────────
export interface CreateVisitInput {
  readonly patientId: string;
  readonly admissionId: string;
  readonly patientAddressId: string | null;
  readonly externalFacilityId: string | null;
  readonly assignedMembershipId: string;
  readonly visitPurpose: VisitPurpose;
  readonly visitSetting: VisitSetting;
  readonly scheduledStartedAt: string;
  readonly scheduledEndedAt: string;
}
export interface EditVisitInput {
  readonly scheduledStartedAt?: string;
  readonly scheduledEndedAt?: string;
  readonly assignedMembershipId?: string;
  readonly visitPurpose?: VisitPurpose;
  readonly visitSetting?: VisitSetting;
}
export interface RescheduleVisitInput {
  readonly newScheduledStartedAt: string;
  readonly newScheduledEndedAt: string;
  readonly newAssignedMembershipId?: string;
  readonly reason: string;
}
export interface CreateRecurringInput {
  readonly patientId: string;
  readonly admissionId: string;
  readonly assignedMembershipId: string;
  readonly visitPurpose: VisitPurpose;
  readonly visitSetting: VisitSetting;
  readonly rrule: string;
}
export interface RequestTimeOffInput {
  readonly membershipId: string;
  readonly kind: TimeOffKind;
  readonly startsAt: string;
  readonly endsAt: string;
}
export interface UpsertAvailabilityInput {
  readonly timeZone: string;
  readonly slots: ReadonlyArray<{ weekday: number; startTime: string; endTime: string }>;
}
export interface OptimizeDayInput {
  readonly membershipId: string;
  readonly serviceDate: string;
}

// ── seed (the §9.3 RLS/ABAC tests + the resolver inject the dataset; default empty = fail-closed) ──────────
export interface SchedulingSeed {
  /** membershipId → the discipline(s) it holds (drives `discipline_matches_visit`). A membership may hold
   *  SEVERAL; a bare value is accepted as the one-element case. */
  readonly disciplines?: Record<string, SchedulingDiscipline | readonly SchedulingDiscipline[]>;
  /** membershipIds whose required credentials are ACTIVE (drives `clinician_credentials_active`). */
  readonly credentialedMemberships?: readonly string[];
  /** `membershipId|patientId` pairs in caseload (drives `within_caseload_or_unassigned_pool`). */
  readonly caseload?: readonly string[];
  /** orgs whose `allow_unassigned_pool_assignment` policy is on. */
  readonly unassignedPoolOrgs?: readonly string[];
}

export interface SchedulingServiceDeps {
  readonly now: () => string;
  readonly newId: () => string;
  readonly seed?: SchedulingSeed;
  /** OSRM adapter (the §25.14 boundary); only consulted when route optimisation is on. */
  readonly routing?: RoutingProvider;
  /** `scheduling.route_optimization` flag — OFF in Phase 1 (the §7.9 degraded path). */
  readonly routeOptimizationEnabled?: boolean;
}

interface VisitRecord {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  patientAddressId: string | null;
  externalFacilityId: string | null;
  assignedMembershipId: string;
  visitPurpose: VisitPurpose;
  visitSetting: VisitSetting;
  scheduledStartedAt: string;
  scheduledEndedAt: string;
  status: VisitStatus;
  rescheduledIntoVisitId: string | null;
  version: number;
}

const serviceDateOf = (iso: string): string => iso.slice(0, 10);
const caseloadKey = (membershipId: string, patientId: string): string =>
  `${membershipId}|${patientId}`;

/**
 * The in-memory M17 route backend. Org-pinned on every read/write (cross-tenant rows are invisible — the
 * Drizzle prod path leans on RLS for the same guarantee). Implements {@link SchedulingAbacResolver} so the
 * §4.7 predicates resolve over the same dataset the routes mutate.
 */
export class SchedulingRouteService implements SchedulingAbacResolver {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly routing?: RoutingProvider;
  private readonly routeOptimizationEnabled: boolean;
  private readonly disciplines: Map<string, SchedulingDiscipline[]>;
  private readonly credentialed: Set<string>;
  private readonly caseload: Set<string>;
  private readonly unassignedPoolOrgs: Set<string>;

  private readonly visits = new Map<string, VisitRecord>();
  private readonly proposals = new Map<string, ProposalView & { organizationId: string }>();
  private readonly recurring = new Map<string, RecurringView & { organizationId: string }>();
  private readonly availability = new Map<string, AvailabilityView & { organizationId: string }>();
  private readonly timeOff = new Map<string, TimeOffView & { organizationId: string }>();
  private readonly events: RecordedSchedulingEvent[] = [];
  // GAP-093 — the in-memory slice's membership_credential rows (route-smoke-test fixture only; the
  // pre-schedule gate itself still reads `credentialed`, a flat per-membership flag kept in sync below).
  private readonly credentials = new Map<string, CredentialRecord & { organizationId: string }>();
  private credentialSeq = 0;

  constructor(deps: SchedulingServiceDeps) {
    this.now = deps.now;
    this.newId = deps.newId;
    this.routing = deps.routing;
    this.routeOptimizationEnabled = deps.routeOptimizationEnabled ?? false;
    this.disciplines = new Map(
      Object.entries(deps.seed?.disciplines ?? {}).map(([k, v]) => [
        k,
        Array.isArray(v) ? [...v] : [v as SchedulingDiscipline],
      ]),
    );
    this.credentialed = new Set(deps.seed?.credentialedMemberships ?? []);
    this.caseload = new Set(deps.seed?.caseload ?? []);
    this.unassignedPoolOrgs = new Set(deps.seed?.unassignedPoolOrgs ?? []);
  }

  /** Drain the recorded outbox events (the M17-T08 relay / tests consume these). */
  drainEvents(): RecordedSchedulingEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // PARAM-004 follow-up — the in-memory reference slice has no org_timezone setting to read (not
  // mounted in production; see module header), so it reports the same "UTC" this file's own
  // `serviceDateOf` already assumes throughout.
  orgTimezone(_orgId: string): Promise<string> {
    return Promise.resolve("UTC");
  }

  // ── visits ──────────────────────────────────────────────────────────────────────────────────────────
  listVisits(
    orgId: string,
    filters: { clinician?: string; patient?: string; from?: string; to?: string; status?: string },
  ): VisitView[] {
    return [...this.visits.values()]
      .filter((v) => v.organizationId === orgId)
      .filter((v) => (filters.clinician ? v.assignedMembershipId === filters.clinician : true))
      .filter((v) => (filters.patient ? v.patientId === filters.patient : true))
      .filter((v) => (filters.status ? v.status === filters.status : true))
      .filter((v) => (filters.from ? v.scheduledStartedAt >= filters.from : true))
      .filter((v) => (filters.to ? v.scheduledStartedAt <= filters.to : true))
      .map(toVisitView);
  }

  getVisit(orgId: string, visitId: string): VisitView {
    return toVisitView(this.requireVisit(orgId, visitId));
  }

  createVisit(orgId: string, _userId: string, input: CreateVisitInput): VisitView {
    const record: VisitRecord = {
      id: this.newId(),
      organizationId: orgId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      patientAddressId: input.patientAddressId,
      externalFacilityId: input.externalFacilityId,
      assignedMembershipId: input.assignedMembershipId,
      visitPurpose: input.visitPurpose,
      visitSetting: input.visitSetting,
      scheduledStartedAt: input.scheduledStartedAt,
      scheduledEndedAt: input.scheduledEndedAt,
      status: "proposed",
      rescheduledIntoVisitId: null,
      version: 0,
    };
    this.record(planVisitProposed(), record.id);
    // §4.1 — a manual create skips the proposal path but still runs the D8 gate, then publishes.
    this.publishRecord(orgId, record, input.scheduledStartedAt);
    this.visits.set(record.id, record);
    return toVisitView(record);
  }

  editVisit(orgId: string, _userId: string, visitId: string, input: EditVisitInput): VisitView {
    const record = this.requireVisit(orgId, visitId);
    const reassigned =
      input.assignedMembershipId !== undefined || input.scheduledStartedAt !== undefined;
    if (input.scheduledStartedAt) record.scheduledStartedAt = input.scheduledStartedAt;
    if (input.scheduledEndedAt) record.scheduledEndedAt = input.scheduledEndedAt;
    if (input.assignedMembershipId) record.assignedMembershipId = input.assignedMembershipId;
    if (input.visitPurpose) record.visitPurpose = input.visitPurpose;
    if (input.visitSetting) record.visitSetting = input.visitSetting;
    if (reassigned) this.assertGate(orgId, record); // §4.1 — rerun the gate on assignment/time change
    record.version += 1;
    return toVisitView(record);
  }

  startVisit(
    orgId: string,
    _userId: string,
    visitId: string,
    evvMissingReason: string | undefined,
    stepUpSatisfied: boolean,
  ): VisitView {
    const record = this.requireVisit(orgId, visitId);
    const transition = transitionVisit(record.status, {
      type: "start",
      source:
        evvMissingReason === undefined
          ? { via: "evv" }
          : { via: "self_attest", evvMissingReason, stepUpSatisfied },
    });
    record.status = transition.to;
    record.version += 1;
    this.record(transition.effects, record.id);
    return toVisitView(record);
  }

  cancelVisit(orgId: string, _userId: string, visitId: string, reason: string): VisitView {
    const record = this.requireVisit(orgId, visitId);
    const transition = transitionVisit(record.status, {
      type: "cancel",
      reason,
      cancelledByPresent: true,
    });
    record.status = transition.to;
    record.version += 1;
    this.record(transition.effects, record.id);
    return toVisitView(record);
  }

  rescheduleVisit(
    orgId: string,
    userId: string,
    visitId: string,
    input: RescheduleVisitInput,
  ): { original: VisitView; created: VisitView } {
    const record = this.requireVisit(orgId, visitId);
    const transition = transitionVisit(record.status, { type: "reschedule", reason: input.reason });
    const created = this.createVisit(orgId, userId, {
      patientId: record.patientId,
      admissionId: record.admissionId,
      patientAddressId: record.patientAddressId,
      externalFacilityId: record.externalFacilityId,
      assignedMembershipId: input.newAssignedMembershipId ?? record.assignedMembershipId,
      visitPurpose: record.visitPurpose,
      visitSetting: record.visitSetting,
      scheduledStartedAt: input.newScheduledStartedAt,
      scheduledEndedAt: input.newScheduledEndedAt,
    });
    record.status = transition.to;
    record.rescheduledIntoVisitId = created.id;
    record.version += 1;
    this.record(transition.effects, record.id);
    return { original: toVisitView(record), created };
  }

  noShowVisit(orgId: string, _userId: string, visitId: string, reason: string): VisitView {
    const record = this.requireVisit(orgId, visitId);
    const transition = transitionVisit(record.status, { type: "no_show", reason });
    record.status = transition.to;
    record.version += 1;
    this.record(transition.effects, record.id);
    return toVisitView(record);
  }

  reassignVisit(
    orgId: string,
    _userId: string,
    visitId: string,
    newAssignedMembershipId: string,
  ): VisitView {
    const record = this.requireVisit(orgId, visitId);
    record.assignedMembershipId = newAssignedMembershipId;
    this.assertGate(orgId, record); // §4.1 — reassign reruns the gate
    record.version += 1;
    this.events.push({ eventName: "m17.visit.assigned", visitId: record.id });
    return toVisitView(record);
  }

  // ── proposals ───────────────────────────────────────────────────────────────────────────────────────
  listProposals(orgId: string, filters: { patient?: string }): ProposalView[] {
    return [...this.proposals.values()]
      .filter((p) => p.organizationId === orgId)
      .filter((p) => (filters.patient ? p.patientId === filters.patient : true))
      .map(stripOrg);
  }

  publishProposal(orgId: string, userId: string, proposalId: string): VisitView {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.organizationId !== orgId) throw new NotFoundError("visit_proposal");
    if (proposal.status !== "pending") throw new ConflictError("proposal is not pending");
    const startedAt = `${proposal.proposedForDate}T13:00:00.000Z`;
    const visit = this.createVisit(orgId, userId, {
      patientId: proposal.patientId,
      admissionId: proposal.admissionId,
      patientAddressId: null,
      externalFacilityId: null,
      assignedMembershipId: proposal.id, // placeholder; the prod proposal carries the proposed membership
      visitPurpose: proposal.proposedVisitPurpose,
      visitSetting: "patient_home",
      scheduledStartedAt: startedAt,
      scheduledEndedAt: `${proposal.proposedForDate}T14:00:00.000Z`,
    });
    this.proposals.set(proposalId, { ...proposal, status: "published" });
    return visit;
  }

  dismissProposal(
    orgId: string,
    _userId: string,
    proposalId: string,
    _reason: string,
  ): ProposalView {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.organizationId !== orgId) throw new NotFoundError("visit_proposal");
    const updated = { ...proposal, status: "dismissed" as const };
    this.proposals.set(proposalId, updated);
    return stripOrg(updated);
  }

  // ── recurring visits ──────────────────────────────────────────────────────────────────────────────────
  listRecurring(orgId: string, patientId: string): RecurringView[] {
    return [...this.recurring.values()]
      .filter((r) => r.organizationId === orgId && r.patientId === patientId)
      .map(stripOrg);
  }

  createRecurring(orgId: string, _userId: string, input: CreateRecurringInput): RecurringView {
    const record = {
      id: this.newId(),
      organizationId: orgId,
      patientId: input.patientId,
      assignedMembershipId: input.assignedMembershipId,
      visitPurpose: input.visitPurpose,
      rrule: input.rrule,
      status: "active" as const,
    };
    this.recurring.set(record.id, record);
    return stripOrg(record);
  }

  discontinueRecurring(orgId: string, _userId: string, id: string): RecurringView {
    const record = this.recurring.get(id);
    if (!record || record.organizationId !== orgId) throw new NotFoundError("recurring_visit");
    const updated = { ...record, status: "discontinued" as const };
    this.recurring.set(id, updated);
    this.events.push({ eventName: "m17.recurring_visit.discontinued", visitId: null });
    return stripOrg(updated);
  }

  // ── availability ──────────────────────────────────────────────────────────────────────────────────────
  getAvailability(orgId: string, membershipId: string): AvailabilityView | null {
    const record = this.availability.get(membershipId);
    return record && record.organizationId === orgId ? stripOrg(record) : null;
  }

  upsertAvailability(
    orgId: string,
    _userId: string,
    membershipId: string,
    input: UpsertAvailabilityInput,
  ): AvailabilityView {
    const record = {
      organizationId: orgId,
      membershipId,
      timeZone: input.timeZone,
      slots: input.slots,
    };
    this.availability.set(membershipId, record);
    return stripOrg(record);
  }

  // ── time off ──────────────────────────────────────────────────────────────────────────────────────────
  listTimeOff(orgId: string, filters: { membership?: string; state?: string }): TimeOffView[] {
    return [...this.timeOff.values()]
      .filter((t) => t.organizationId === orgId)
      .filter((t) => (filters.membership ? t.membershipId === filters.membership : true))
      .filter((t) => (filters.state ? t.state === filters.state : true))
      .map(stripOrg);
  }

  requestTimeOff(orgId: string, _userId: string, input: RequestTimeOffInput): TimeOffView {
    const record = {
      id: this.newId(),
      organizationId: orgId,
      membershipId: input.membershipId,
      kind: input.kind,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      state: "requested" as TimeOffState,
    };
    this.timeOff.set(record.id, record);
    this.events.push({ eventName: "m17.time_off.requested", visitId: null });
    return stripOrg(record);
  }

  approveTimeOff(orgId: string, _userId: string, id: string): TimeOffView {
    return this.transitionTimeOff(orgId, id, "approved", "m17.time_off.approved");
  }

  denyTimeOff(orgId: string, _userId: string, id: string, _reason: string): TimeOffView {
    return this.transitionTimeOff(orgId, id, "denied", "m17.time_off.denied");
  }

  cancelTimeOff(orgId: string, _userId: string, id: string): TimeOffView {
    return this.transitionTimeOff(orgId, id, "cancelled", null);
  }

  private transitionTimeOff(
    orgId: string,
    id: string,
    state: TimeOffState,
    eventName: string | null,
  ): TimeOffView {
    const record = this.timeOff.get(id);
    if (!record || record.organizationId !== orgId) throw new NotFoundError("time_off");
    const updated = { ...record, state };
    this.timeOff.set(id, updated);
    if (eventName) this.events.push({ eventName, visitId: null });
    return stripOrg(updated);
  }

  // ── views + optimisation ──────────────────────────────────────────────────────────────────────────────
  dayView(
    orgId: string,
    membershipId: string | undefined,
    date: string,
  ): { date: string; membershipId: string | null; visits: VisitView[] } {
    const visits = this.listVisits(orgId, { clinician: membershipId }).filter(
      (v) => v.serviceDate === date,
    );
    return { date, membershipId: membershipId ?? null, visits };
  }

  weekView(
    orgId: string,
    membershipId: string | undefined,
    weekStart: string,
  ): { weekStart: string; membershipId: string | null; visits: VisitView[] } {
    const visits = this.listVisits(orgId, { clinician: membershipId }).filter(
      (v) => v.serviceDate >= weekStart,
    );
    return { weekStart, membershipId: membershipId ?? null, visits };
  }

  mapView(
    orgId: string,
    membershipId: string,
    date: string,
  ): { membershipId: string; date: string; stops: VisitView[] } {
    // §4.1 / D9 — polylines are coords-only; the in-mem slice returns the ordered stops (the route worker is T08).
    const stops = this.listVisits(orgId, { clinician: membershipId }).filter(
      (v) => v.serviceDate === date,
    );
    return { membershipId, date, stops };
  }

  /** §7.9 — on-demand optimisation. With the flag OFF (Phase 1) or OSRM unhealthy, returns the degraded result. */
  async optimizeDay(
    orgId: string,
    _userId: string,
    input: OptimizeDayInput,
  ): Promise<{
    membershipId: string;
    serviceDate: string;
    degraded: boolean;
    reason?: string;
    segmentCount: number;
  }> {
    if (!this.routeOptimizationEnabled || !this.routing) {
      this.events.push({ eventName: "m17.route_optimization_degraded", visitId: null });
      return {
        membershipId: input.membershipId,
        serviceDate: input.serviceDate,
        degraded: true,
        reason: "optimization_disabled",
        segmentCount: 0,
      };
    }
    if (!(await this.routing.healthy())) {
      this.events.push({ eventName: "m17.route_optimization_degraded", visitId: null });
      return {
        membershipId: input.membershipId,
        serviceDate: input.serviceDate,
        degraded: true,
        reason: "osrm_unavailable",
        segmentCount: 0,
      };
    }
    const stops = this.dayView(orgId, input.membershipId, input.serviceDate).visits;
    this.events.push({ eventName: "m17.route_optimized", visitId: null });
    return {
      membershipId: input.membershipId,
      serviceDate: input.serviceDate,
      degraded: false,
      segmentCount: Math.max(0, stops.length - 1),
    };
  }

  portalUpcoming(
    orgId: string,
    patientId: string,
    withinHours: number,
  ): Array<{
    visitId: string;
    scheduledStartedAt: string;
    scheduledEndedAt: string;
    visitPurposeLabel: string;
    visitSetting: VisitSetting;
  }> {
    const cutoff = new Date(Date.parse(this.now()) + withinHours * 3_600_000).toISOString();
    return this.listVisits(orgId, { patient: patientId, status: "published" })
      .filter((v) => v.scheduledStartedAt <= cutoff)
      .map((v) => ({
        visitId: v.id,
        scheduledStartedAt: v.scheduledStartedAt,
        scheduledEndedAt: v.scheduledEndedAt,
        visitPurposeLabel: "Scheduled visit", // §4.3 — lay-language, never the raw enum; scheduler notes scrubbed
        visitSetting: v.visitSetting,
      }));
  }

  visitMetrics(
    orgId: string,
    _window: { from: string; to: string },
  ): { onTimeRate: number; noShowRate: number; rescheduleRate: number } {
    const visits = this.listVisits(orgId, {});
    const total = visits.length || 1;
    const noShow = visits.filter((v) => v.status === "no_show").length;
    const rescheduled = visits.filter((v) => v.status === "rescheduled").length;
    return { onTimeRate: 1, noShowRate: noShow / total, rescheduleRate: rescheduled / total };
  }

  routeEfficiencyMetrics(
    _orgId: string,
    membershipId: string,
  ): { membershipId: string; totalProposedMiles: number; overrideRate: number } {
    return { membershipId, totalProposedMiles: 0, overrideRate: 0 };
  }

  // ── SchedulingAbacResolver (§4.7) — resolves over the same dataset ────────────────────────────────────
  async resolveDisciplines(
    _orgId: string,
    membershipId: string,
  ): Promise<SchedulingDiscipline[]> {
    return this.disciplines.get(membershipId) ?? [];
  }

  async credentialsActiveForPurpose(
    _orgId: string,
    membershipId: string,
    _visitPurpose: VisitPurpose,
    _serviceDate: string,
  ): Promise<boolean> {
    return this.credentialed.has(membershipId);
  }

  async hasApprovedTimeOffOverlap(
    orgId: string,
    membershipId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<boolean> {
    return [...this.timeOff.values()].some(
      (t) =>
        t.organizationId === orgId &&
        t.membershipId === membershipId &&
        t.state === "approved" &&
        t.startsAt < endsAt &&
        t.endsAt > startsAt,
    );
  }

  async allowsUnassignedPool(orgId: string): Promise<boolean> {
    return this.unassignedPoolOrgs.has(orgId);
  }

  async isInCaseload(_orgId: string, membershipId: string, patientId: string): Promise<boolean> {
    return this.caseload.has(caseloadKey(membershipId, patientId));
  }

  // ── GAP-093 — membership_credential grant/revoke/list (slice fixture) ────────────────────────────────
  async listCredentials(orgId: string, membershipId: string): Promise<CredentialRecord[]> {
    return [...this.credentials.values()].filter(
      (c) => c.organizationId === orgId && c.membershipId === membershipId,
    );
  }

  async grantCredential(
    orgId: string,
    grantedByMembershipId: string,
    input: {
      membershipId: string;
      credentialType: CredentialDiscipline;
      effectiveAt: string;
      expiresAt?: string | null;
      issuingBody?: string | null;
    },
  ): Promise<CredentialRecord> {
    const record: CredentialRecord & { organizationId: string } = {
      id: `cred-${++this.credentialSeq}`,
      organizationId: orgId,
      membershipId: input.membershipId,
      credentialType: input.credentialType,
      status: "active",
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      revokedReason: null,
      issuingBody: input.issuingBody ?? null,
      grantedByMembershipId,
      createdAt: this.now(),
    };
    this.credentials.set(record.id, record);
    this.credentialed.add(input.membershipId); // keep the flat gate flag in sync (slice fixture only)
    return record;
  }

  async revokeCredential(
    orgId: string,
    _revokedByMembershipId: string,
    credentialId: string,
    revokedReason: string,
  ): Promise<void> {
    const existing = this.credentials.get(credentialId);
    if (!existing || existing.organizationId !== orgId) {
      throw new NotFoundError("membership credential", credentialId);
    }
    this.credentials.set(credentialId, {
      ...existing,
      status: "revoked",
      revokedAt: this.now(),
      revokedReason,
    });
    const stillCredentialed = [...this.credentials.values()].some(
      (c) => c.membershipId === existing.membershipId && c.status === "active",
    );
    if (!stillCredentialed) this.credentialed.delete(existing.membershipId);
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────
  private requireVisit(orgId: string, visitId: string): VisitRecord {
    const record = this.visits.get(visitId);
    if (!record || record.organizationId !== orgId) throw new NotFoundError("visit");
    return record;
  }

  /** Compute the §1.1 D8 pre-schedule gate synchronously over the seeded facts (the publish/edit/reassign gate). */
  private gatePassedSync(orgId: string, record: VisitRecord): boolean {
    const held = this.disciplines.get(record.assignedMembershipId) ?? [];
    const disciplineOk = held.some((d) =>
      VISIT_PURPOSE_DISCIPLINES[record.visitPurpose].includes(d),
    );
    const credentialsOk = this.credentialed.has(record.assignedMembershipId);
    const pto = [...this.timeOff.values()].some(
      (t) =>
        t.organizationId === orgId &&
        t.membershipId === record.assignedMembershipId &&
        t.state === "approved" &&
        t.startsAt < record.scheduledEndedAt &&
        t.endsAt > record.scheduledStartedAt,
    );
    const poolOrCaseload =
      this.unassignedPoolOrgs.has(orgId) ||
      this.caseload.has(caseloadKey(record.assignedMembershipId, record.patientId));
    return disciplineOk && credentialsOk && !pto && poolOrCaseload;
  }

  private assertGate(orgId: string, record: VisitRecord): void {
    if (!this.gatePassedSync(orgId, record)) {
      throw new ForbiddenError("PRE_SCHEDULE_GATE_FAILED");
    }
  }

  private publishRecord(orgId: string, record: VisitRecord, _startedAt: string): void {
    const transition = transitionVisit(record.status, {
      type: "publish",
      gatePassed: this.gatePassedSync(orgId, record),
    });
    record.status = transition.to;
    record.version += 1;
    this.record(transition.effects, record.id);
  }

  private record(effects: ReadonlyArray<{ kind: string; event?: string }>, visitId: string): void {
    for (const effect of effects) {
      if (effect.kind === "outbox" && effect.event)
        this.events.push({ eventName: effect.event, visitId });
    }
  }
}

function toVisitView(record: VisitRecord): VisitView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    patientId: record.patientId,
    admissionId: record.admissionId,
    assignedMembershipId: record.assignedMembershipId,
    visitPurpose: record.visitPurpose,
    visitSetting: record.visitSetting,
    scheduledStartedAt: record.scheduledStartedAt,
    scheduledEndedAt: record.scheduledEndedAt,
    serviceDate: serviceDateOf(record.scheduledStartedAt),
    status: record.status,
    patientAddressId: record.patientAddressId,
    externalFacilityId: record.externalFacilityId,
    rescheduledIntoVisitId: record.rescheduledIntoVisitId,
  };
}

/** Strip the internal `organizationId` from a stored view record (the route never returns it twice). */
function stripOrg<T extends { organizationId: string }>(record: T): Omit<T, "organizationId"> {
  const { organizationId: _omit, ...rest } = record;
  return rest;
}
