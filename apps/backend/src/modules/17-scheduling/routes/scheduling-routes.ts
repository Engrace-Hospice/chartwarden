// apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts — M17-T07 the §4.1 route inventory behind
// the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the §4.6 keys
// M17 registers into M3's catalog (M17_CONTRIBUTED_PERMISSIONS). Org binding is server-side (`request.context`,
// never the body). Handlers compose over the injected SchedulingRouteService (in-memory slice; Drizzle in prod
// under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the assignment-write CREATE route composes the four OWNED pre-schedule predicates
// (`clinician_credentials_active` ∧ `discipline_matches_visit` ∧ `not_on_pto` ∧
// `within_caseload_or_unassigned_pool`) against a target lifted from the body (the assigned membership, the
// visit purpose, the service date, the scheduled window, the patient). The publish/reassign/edit paths re-run
// the D8 gate in the SERVICE layer (the visit machine takes the already-computed `gatePassed` verdict per
// §2.2.1), so those routes carry the RBAC key alone. The portal route runs under the portal session class.
import { type AbacTarget, type GuardRequest, requireAbac, requirePermission } from "@wardenx/auth";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ApproveTimeOffRequest,
  AvailabilityQuerySchema,
  CancelTimeOffRequest,
  CancelVisitRequest,
  CreateRecurringVisitRequest,
  CreateVisitRequest,
  DayViewQuerySchema,
  DenyTimeOffRequest,
  DiscontinueRecurringVisitRequest,
  DismissProposalRequest,
  EditVisitRequest,
  IdParamsSchema,
  MapViewQuerySchema,
  MembershipIdParamsSchema,
  MetricsQuerySchema,
  NoShowVisitRequest,
  OptimizeDayRequest,
  PortalUpcomingQuerySchema,
  ProposalIdParamsSchema,
  ProposalListQuerySchema,
  ReassignVisitRequest,
  RecurringListQuerySchema,
  RequestTimeOffRequest,
  RescheduleVisitRequest,
  RouteEfficiencyQuerySchema,
  StartVisitRequest,
  TimeOffListQuerySchema,
  UpsertAvailabilityRequest,
  VisitIdParamsSchema,
  VisitListQuerySchema,
  WeekViewQuerySchema,
  parse,
} from "./scheduling-typebox";
import type { SchedulingRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SchedulingRouteDeps {
  service: SchedulingRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** The M2 step-up freshness signal (header set by the M2 step-up flow; the self-attest start path needs it). */
const stepUpFreshOf = (request: FastifyRequest): boolean =>
  request.headers["x-step-up"] === "fresh";

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("visit.read");
const READ_METRICS = P("visit.read_metrics");
const CREATE = P("visit.create");
const EDIT = P("visit.edit");
const START = P("visit.start");
const CANCEL = P("visit.cancel");
const RESCHEDULE = P("visit.reschedule");
const REASSIGN = P("visit.reassign");
const MARK_NO_SHOW = P("visit.mark_no_show");
const PROPOSAL_READ = P("visit.proposal.read");
const PROPOSAL_DISMISS = P("visit.proposal.dismiss");
const RECURRING_READ = P("recurring_visit.read");
const RECURRING_CREATE = P("recurring_visit.create");
const RECURRING_DISCONTINUE = P("recurring_visit.discontinue");
const AVAIL_READ = P("availability.read");
const AVAIL_EDIT = P("availability.edit_own");
const TIME_OFF_READ = P("time_off.read_own");
const TIME_OFF_REQUEST = P("time_off.request_own");
const TIME_OFF_APPROVE = P("time_off.approve");
const TIME_OFF_CANCEL = P("time_off.cancel_own");
const OPTIMIZE = P("route.optimize_on_demand");
const ROUTE_METRICS = P("route.read_metrics");
const PORTAL_READ = P("portal.visit.read_upcoming");

// PARAM-004 follow-up — `requireAbac`'s `getTarget` (packages/auth/src/abac/require-abac.ts) is
// SYNCHRONOUS, so `createGateTarget` below cannot itself resolve `orgId`'s configured timezone from
// the DB. Instead an earlier preHandler (`resolveOrgTimezone`) fetches it once and stashes it on
// `request.context.attributes.orgTimezone`, ordered right after `CREATE` (RBAC) and before every
// `GATE(...)` predicate on the create route, so `createGateTarget` can read it back synchronously.
function resolveOrgTimezone(service: SchedulingRouteService): PreHandler {
  return async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) return; // no org bound — CREATE's own guard denies before this matters
    ctx.attributes.orgTimezone = await service.orgTimezone(ctx.organizationId);
  };
}

// §4.7 — the create route's pre-schedule gate target (lifted from the body, never params).
const createGateTarget = (request: GuardRequest): AbacTarget => {
  const body = (request.body ?? {}) as {
    assignedMembershipId?: unknown;
    visitPurpose?: unknown;
    patientId?: unknown;
    scheduledStartedAt?: unknown;
    scheduledEndedAt?: unknown;
  };
  const target: Record<string, unknown> = {};
  if (typeof body.assignedMembershipId === "string")
    target.membershipId = body.assignedMembershipId;
  if (typeof body.visitPurpose === "string") target.visitPurpose = body.visitPurpose;
  if (typeof body.patientId === "string") target.patientId = body.patientId;
  if (typeof body.scheduledStartedAt === "string") {
    target.scheduledStartedAt = body.scheduledStartedAt;
    // The service date the D8 predicates (credentials-active-as-of, PTO overlap) reason about is the
    // ORG-LOCAL calendar date this visit falls on, not a naive UTC-instant slice (PARAM-004) — resolved
    // by `resolveOrgTimezone` above; "UTC" only if that preHandler somehow didn't run first.
    const timezone = (request.context.attributes.orgTimezone as string | undefined) ?? "UTC";
    target.serviceDate = localDateInTimeZone(new Date(body.scheduledStartedAt), timezone);
  }
  if (typeof body.scheduledEndedAt === "string") target.scheduledEndedAt = body.scheduledEndedAt;
  return target;
};
const GATE = (predicate: string): PreHandler =>
  requireAbac("visit.create", predicate, { getTarget: createGateTarget }) as PreHandler;
const ABAC_CREDENTIALS = GATE("clinician_credentials_active");
const ABAC_DISCIPLINE = GATE("discipline_matches_visit");
const ABAC_NOT_ON_PTO = GATE("not_on_pto");
const ABAC_POOL = GATE("within_caseload_or_unassigned_pool");

export function registerSchedulingRoutes(app: FastifyInstance, deps: SchedulingRouteDeps): void {
  const { service } = deps;

  // 1 — list visits with filters.
  app.get(
    "/api/v1/visits",
    { preHandler: [READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(VisitListQuerySchema, request.query);
      return service.listVisits(organizationId, {
        clinician: q.clinician,
        patient: q.patient,
        from: q.from,
        to: q.to,
        status: q.status,
      });
    },
  );

  // 2 — fetch one visit.
  app.get(
    "/api/v1/visits/:visitId",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "visit", resourceIdParam: "visitId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { visitId } = parse(VisitIdParamsSchema, request.params);
      return service.getVisit(organizationId, visitId);
    },
  );

  // 3 — direct manual create (skips the proposal path); runs the D8 pre-schedule gate (four §4.7 predicates).
  app.post(
    "/api/v1/visits",
    {
      preHandler: [
        CREATE,
        resolveOrgTimezone(service),
        ABAC_CREDENTIALS,
        ABAC_DISCIPLINE,
        ABAC_NOT_ON_PTO,
        ABAC_POOL,
      ],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(CreateVisitRequest, request.body);
      const res = service.createVisit(organizationId, userId, {
        patientId: b.patientId,
        admissionId: b.admissionId,
        patientAddressId: b.patientAddressId,
        externalFacilityId: b.externalFacilityId,
        assignedMembershipId: b.assignedMembershipId,
        visitPurpose: b.visitPurpose,
        visitSetting: b.visitSetting,
        scheduledStartedAt: b.scheduledStartedAt,
        scheduledEndedAt: b.scheduledEndedAt,
      });
      return reply.code(201).send(res);
    },
  );

  // 4 — edit times / discipline / assignment (reruns the gate in-service on assignment/time change).
  app.patch("/api/v1/visits/:visitId", { preHandler: [EDIT] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const b = parse(EditVisitRequest, request.body);
    return service.editVisit(organizationId, userId, visitId, b);
  });

  // 5 — self-attest start (EVV-missing path).
  app.post("/api/v1/visits/:visitId/start", { preHandler: [START] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const b = parse(StartVisitRequest, request.body);
    return service.startVisit(
      organizationId,
      userId,
      visitId,
      b.evvMissingReason,
      stepUpFreshOf(request),
    );
  });

  // 6 — cancel a visit (reason ≥ 20 chars).
  app.post("/api/v1/visits/:visitId/cancel", { preHandler: [CANCEL] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const b = parse(CancelVisitRequest, request.body);
    return service.cancelVisit(organizationId, userId, visitId, b.reason);
  });

  // 7 — reschedule a visit (creates a new visit; original → rescheduled).
  app.post(
    "/api/v1/visits/:visitId/reschedule",
    { preHandler: [RESCHEDULE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { visitId } = parse(VisitIdParamsSchema, request.params);
      const b = parse(RescheduleVisitRequest, request.body);
      const res = service.rescheduleVisit(organizationId, userId, visitId, {
        newScheduledStartedAt: b.newScheduledStartedAt,
        newScheduledEndedAt: b.newScheduledEndedAt,
        newAssignedMembershipId: b.newAssignedMembershipId,
        reason: b.reason,
      });
      return reply.code(201).send(res);
    },
  );

  // 8 — mark no-show (triggers reassign-or-followup workflow).
  app.post("/api/v1/visits/:visitId/no-show", { preHandler: [MARK_NO_SHOW] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const b = parse(NoShowVisitRequest, request.body);
    return service.noShowVisit(organizationId, userId, visitId, b.reason);
  });

  // 9 — reassign-only (no time change; reruns the gate in-service).
  app.post("/api/v1/visits/:visitId/reassign", { preHandler: [REASSIGN] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const b = parse(ReassignVisitRequest, request.body);
    return service.reassignVisit(organizationId, userId, visitId, b.newAssignedMembershipId);
  });

  // 10 — scheduler proposal inbox.
  app.get(
    "/api/v1/visit-proposals",
    {
      preHandler: [PROPOSAL_READ],
      config: { auditRead: { resourceKind: "visit_proposal", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ProposalListQuerySchema, request.query);
      return service.listProposals(organizationId, { patient: q.patient });
    },
  );

  // 11 — publish a proposal as a real visit (runs the gate in-service).
  app.post(
    "/api/v1/visit-proposals/:proposalId/publish",
    { preHandler: [CREATE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { proposalId } = parse(ProposalIdParamsSchema, request.params);
      const res = service.publishProposal(organizationId, userId, proposalId);
      return reply.code(201).send(res);
    },
  );

  // 12 — dismiss a proposal (reason).
  app.post(
    "/api/v1/visit-proposals/:proposalId/dismiss",
    { preHandler: [PROPOSAL_DISMISS] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { proposalId } = parse(ProposalIdParamsSchema, request.params);
      const b = parse(DismissProposalRequest, request.body);
      return service.dismissProposal(organizationId, userId, proposalId, b.reason);
    },
  );

  // 13 — list active recurring policies for a patient.
  app.get(
    "/api/v1/recurring-visits",
    {
      preHandler: [RECURRING_READ],
      config: { auditRead: { resourceKind: "recurring_visit", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(RecurringListQuerySchema, request.query);
      return service.listRecurring(organizationId, q.patient);
    },
  );

  // 14 — create a recurring policy (validates the RRULE subset in the domain).
  app.post(
    "/api/v1/recurring-visits",
    { preHandler: [RECURRING_CREATE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(CreateRecurringVisitRequest, request.body);
      const res = service.createRecurring(organizationId, userId, {
        patientId: b.patientId,
        admissionId: b.admissionId,
        assignedMembershipId: b.assignedMembershipId,
        visitPurpose: b.visitPurpose,
        visitSetting: b.visitSetting,
        rrule: b.rrule,
      });
      return reply.code(201).send(res);
    },
  );

  // 15 — discontinue a recurring policy (cascade-cancels future child visits in-service).
  app.post(
    "/api/v1/recurring-visits/:id/discontinue",
    { preHandler: [RECURRING_DISCONTINUE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(DiscontinueRecurringVisitRequest, request.body);
      return service.discontinueRecurring(organizationId, userId, id);
    },
  );

  // 16 — read a clinician's weekly availability.
  app.get(
    "/api/v1/availability",
    {
      preHandler: [AVAIL_READ],
      config: {
        auditRead: {
          none: "Clinician weekly availability windows only; no patient identifiers or PHI in the response.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AvailabilityQuerySchema, request.query);
      return service.getAvailability(organizationId, q.membership);
    },
  );

  // 17 — upsert a clinician's weekly availability (own; supervisor edits any).
  app.put("/api/v1/availability/:membershipId", { preHandler: [AVAIL_EDIT] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { membershipId } = parse(MembershipIdParamsSchema, request.params);
    const b = parse(UpsertAvailabilityRequest, request.body);
    return service.upsertAvailability(organizationId, userId, membershipId, b);
  });

  // 18 — list PTO requests (own; supervisor reads team).
  app.get(
    "/api/v1/time-off",
    {
      preHandler: [TIME_OFF_READ],
      config: {
        auditRead: {
          none: "Clinician PTO/time-off request records only; no patient identifiers or PHI in the response.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(TimeOffListQuerySchema, request.query);
      return service.listTimeOff(organizationId, { membership: q.membership, state: q.state });
    },
  );

  // 19 — request PTO.
  app.post("/api/v1/time-off", { preHandler: [TIME_OFF_REQUEST] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(RequestTimeOffRequest, request.body);
    const res = service.requestTimeOff(organizationId, userId, {
      membershipId: b.membershipId,
      kind: b.kind,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
    });
    return reply.code(201).send(res);
  });

  // 20 — approve PTO (triggers reassignment-scan in-service).
  app.post("/api/v1/time-off/:id/approve", { preHandler: [TIME_OFF_APPROVE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    parse(ApproveTimeOffRequest, request.body);
    return service.approveTimeOff(organizationId, userId, id);
  });

  // 21 — deny PTO (reason ≥ 20 chars).
  app.post("/api/v1/time-off/:id/deny", { preHandler: [TIME_OFF_APPROVE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const b = parse(DenyTimeOffRequest, request.body);
    return service.denyTimeOff(organizationId, userId, id, b.reason);
  });

  // 22 — cancel own pre-start PTO.
  app.post("/api/v1/time-off/:id/cancel", { preHandler: [TIME_OFF_CANCEL] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    parse(CancelTimeOffRequest, request.body);
    return service.cancelTimeOff(organizationId, userId, id);
  });

  // 23 — day-view for a clinician or org-wide.
  app.get(
    "/api/v1/day-view",
    { preHandler: [READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(DayViewQuerySchema, request.query);
      return service.dayView(organizationId, q.membership, q.date);
    },
  );

  // 24 — week-view.
  app.get(
    "/api/v1/week-view",
    { preHandler: [READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(WeekViewQuerySchema, request.query);
      return service.weekView(organizationId, q.membership, q.weekStart);
    },
  );

  // 25 — map-view (D9 — coords-only polylines, no PHI text).
  app.get(
    "/api/v1/map-view",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          none: "D9 coords-only route polylines; no patient names, ids, or PHI text in the response.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MapViewQuerySchema, request.query);
      return service.mapView(organizationId, q.membership, q.date);
    },
  );

  // 26 — on-demand optimisation (behind scheduling.route_optimization, OFF; §7.9 degraded path otherwise).
  app.post("/api/v1/optimize-day", { preHandler: [OPTIMIZE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(OptimizeDayRequest, request.body);
    return service.optimizeDay(organizationId, userId, {
      membershipId: b.membershipId,
      serviceDate: b.serviceDate,
    });
  });

  // 27 — portal upcoming visits (portal session class; lay-language; scrubbed).
  app.get(
    "/api/v1/portal/upcoming",
    { preHandler: [PORTAL_READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(PortalUpcomingQuerySchema, request.query);
      return service.portalUpcoming(organizationId, q.patient, q.withinHours ?? 168);
    },
  );

  // 28 — visit metrics (M30/M33 dashboard source).
  app.get(
    "/api/v1/metrics/visits",
    {
      preHandler: [READ_METRICS],
      config: {
        auditRead: {
          none: "Aggregate visit-count metrics for M30/M33 dashboards; no patient-identifying data in the response.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MetricsQuerySchema, request.query);
      return service.visitMetrics(organizationId, { from: q.from, to: q.to });
    },
  );

  // 29 — route-efficiency metrics (M33 dashboard source).
  app.get(
    "/api/v1/metrics/route-efficiency",
    {
      preHandler: [ROUTE_METRICS],
      config: {
        auditRead: {
          none: "Aggregate route-efficiency metrics (mileage/time) for M33 dashboards; no patient-identifying data in the response.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(RouteEfficiencyQuerySchema, request.query);
      return service.routeEfficiencyMetrics(organizationId, q.membership);
    },
  );
}
