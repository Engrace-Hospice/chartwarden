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
import {
  type AbacTarget,
  type GuardRequest,
  hasOrgWideScope,
  requireAbac,
  requirePermission,
  resolveActorPermissions,
} from "@wardenx/auth";
import { localDateInTimeZone } from "@wardenx/shared/dates";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSeam, requestStepUpFresh } from "../../../bootstrap/index";
import { assertAssignedClinician } from "./assigned-clinician";
import { type CallerAuthority, NO_AUTHORITY } from "./own-vs-any";
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
  EligibleCliniciansQuerySchema,
  GrantCredentialRequest,
  IdParamsSchema,
  MapViewQuerySchema,
  MembershipCredentialParamsSchema,
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
  RevokeCredentialRequest,
  RouteEfficiencyQuerySchema,
  StartVisitRequest,
  TimeOffListQuerySchema,
  UpsertAvailabilityRequest,
  VisitIdParamsSchema,
  VisitListQuerySchema,
  WeekViewQuerySchema,
  parse,
} from "./scheduling-typebox";
import type { SchedulingRouteService, VisitReadScope } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SchedulingRouteDeps {
  service: SchedulingRouteService;
  /**
   * The patients on a clinician's caseload (GAP-053) — defaults to M5's published `CaseloadProvider` seam.
   * `userId` is the M2 USER id (what `patient_assignment.clinician_user_id` keys on), not a membership id.
   */
  caseloadPatientIds?: (q: {
    organizationId: string;
    userId: string;
  }) => Promise<readonly string[]>;
}

type CaseloadPatientIds = NonNullable<SchedulingRouteDeps["caseloadPatientIds"]>;

const defaultCaseloadPatientIds: CaseloadPatientIds = (q) =>
  getSeam("CaseloadProvider").caseloadPatientIds(q);

/** Permission that widens visit reads from the caller's caseload to the whole team (M17 §4.6). */
const READ_TEAM_PERMISSION = "visit.read_team";

/** Sentinel patient for a visit that cannot be resolved: it is on no caseload, so the scope guard denies. */
const UNRESOLVED_PATIENT = "00000000-0000-0000-0000-000000000000";

/**
 * GAP-053 — the narrowing a visit / proposal read applies. Org-wide scope roles and `visit.read_team` holders
 * are unrestricted; everyone else sees their caseload (plus the one patient a pinned collaborator / portal
 * session names) and, for visits, the visits assigned to them. Fail-CLOSED: a caseload that cannot be
 * resolved narrows to nothing rather than widening to the org.
 */
async function readScopeOf(
  request: FastifyRequest,
  caseloadPatientIds: CaseloadPatientIds,
): Promise<VisitReadScope> {
  const ctx = request.context;
  if (hasOrgWideScope(ctx.roles)) return { patientIds: null };
  const granted = await resolveActorPermissions({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  if (granted.has(READ_TEAM_PERMISSION)) return { patientIds: null };
  const membershipId = ctx.attributes.membershipId;
  const assignedMembershipId =
    typeof membershipId === "string" && membershipId.length > 0 ? membershipId : undefined;
  const pinned = ctx.attributes.sessionPatientId;
  const sessionIds = typeof pinned === "string" && pinned.length > 0 ? [pinned] : [];
  if (!ctx.userId) return { patientIds: sessionIds, assignedMembershipId };
  try {
    const caseload = await caseloadPatientIds({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
    return { patientIds: [...new Set([...caseload, ...sessionIds])], assignedMembershipId };
  } catch {
    return { patientIds: sessionIds, assignedMembershipId };
  }
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the acting MEMBERSHIP id (see scheduling-route-service-db.ts's own header
  // comment: "the acting membership is the passed `userId` (stored as `actor_membership_id` on
  // `visit_state_history`...)"). This used to read `ctx.userId` (the raw Better Auth user id, a
  // different id space), FK-violating every write.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

/**
 * The M2 step-up freshness signal the self-attest (EVV-missing) start path gates on.
 *
 * Was `request.headers["x-step-up"] === "fresh"` — a client-supplied string, so the step-up requirement
 * on a self-attested visit start was satisfiable by anyone who knew the header name (F-028). Resolves
 * the real session state through M2's seam now; the boolean stays because the service, not a guard,
 * decides what a stale step-up means for this route (a normal EVV-captured start does not need one).
 */
const START_STEP_UP_OPERATION = "visit.start";

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
const TIME_OFF_REQUEST = P("time_off.request_own");
const TIME_OFF_APPROVE = P("time_off.approve");

/** RBAC gate that passes when the caller holds ANY of `keys` (spec §4.6 "X or Y" rows). Fails closed. */
const anyPermission =
  (...keys: string[]): PreHandler =>
  async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) throw new UnauthorizedError();
    const granted = await resolveActorPermissions({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
    if (!keys.some((k) => granted.has(k))) {
      throw new ForbiddenError(`requires permission '${keys.join("' or '")}'`);
    }
  };
const AVAIL_EDIT = anyPermission("availability.edit_own", "availability.edit_any");
const TIME_OFF_READ = anyPermission("time_off.read_own", "time_off.read_team");
const TIME_OFF_CANCEL = anyPermission("time_off.cancel_own", "time_off.approve");

/**
 * GAP-051 — the own-vs-any widening keys the caller holds, resolved from the RBAC engine (never from a body
 * or header). The service enforces the same rule again; a resolver failure widens nothing.
 */
async function authorityOf(request: FastifyRequest): Promise<CallerAuthority> {
  const ctx = request.context;
  try {
    const granted = await resolveActorPermissions({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
    return {
      availabilityEditAny: granted.has("availability.edit_any"),
      timeOffReadTeam: granted.has("time_off.read_team"),
      timeOffApprove: granted.has("time_off.approve"),
    };
  } catch {
    return NO_AUTHORITY;
  }
}
const OPTIMIZE = P("route.optimize_on_demand");
const ROUTE_METRICS = P("route.read_metrics");
const PORTAL_READ = P("portal.visit.read_upcoming");
// GAP-132 — the portal session is paired with its pinned patient by an ACTIVE M31 grant AND a live M39 consent
// (`portal_grant_active_for_patient`, resolved by name from the shared ABAC registry — no M31 import). Account and
// patient come from the SESSION, never the request; a withdrawn consent refuses the read before any byte crosses.
const sessionAttrOf = (request: FastifyRequest, key: string): string => {
  const value = request.context?.attributes?.[key];
  return typeof value === "string" ? value : "";
};
const ABAC_PORTAL_GRANT = (action: string): PreHandler =>
  requireAbac(action, "portal_grant_active_for_patient", {
    getTarget: ((r: FastifyRequest) => ({
      portalAccountId: sessionAttrOf(r, "portalAccountId"),
      patientId: sessionAttrOf(r, "sessionPatientId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;
const PORTAL_GRANT = ABAC_PORTAL_GRANT("portal.visit.read_upcoming");
const CREDENTIAL_READ = P("membership_credential.read");
const CREDENTIAL_GRANT = P("membership_credential.grant");
const CREDENTIAL_REVOKE = P("membership_credential.revoke");

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
// GAP-093 — re-attached to POST /visits below now that a real CredentialReader seam exists (M17's
// new membership_credential table + grant/revoke routes) — see that route's comment.
const ABAC_CREDENTIALS = GATE("clinician_credentials_active");
const ABAC_DISCIPLINE = GATE("discipline_matches_visit");
const ABAC_NOT_ON_PTO = GATE("not_on_pto");
const ABAC_POOL = GATE("within_caseload_or_unassigned_pool");

export function registerSchedulingRoutes(app: FastifyInstance, deps: SchedulingRouteDeps): void {
  const { service } = deps;
  const caseloadPatientIds = deps.caseloadPatientIds ?? defaultCaseloadPatientIds;
  const readScope = (request: FastifyRequest) => readScopeOf(request, caseloadPatientIds);

  // GAP-053 — per-visit caseload scope on the detail read. `requireAbac`'s `getTarget` is synchronous, so this
  // guard first loads the visit (org-scoped, RLS-backstopped), then runs the shared `caseload_or_scope`
  // predicate over its patient with `notFoundOnDeny`. Team-wide readers and the visit's own assignee skip the
  // predicate; an absent / cross-tenant visit resolves to a patient nobody covers → 404, never an allow.
  const resolvedPatient = new WeakMap<object, string>();
  const visitScopeGuard = requireAbac("visit.read", "caseload_or_scope", {
    getTarget: (request) => ({ patientId: resolvedPatient.get(request) ?? UNRESOLVED_PATIENT }),
    notFoundOnDeny: true,
  }) as PreHandler;
  const VISIT_SCOPE: PreHandler = async (request, reply) => {
    const { organizationId } = actorOf(request);
    const scope = await readScope(request);
    if (scope.patientIds === null) return;
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    let visit: { patientId: string; assignedMembershipId: string } | null = null;
    try {
      visit = await service.getVisit(organizationId, visitId);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    if (visit && scope.assignedMembershipId === visit.assignedMembershipId) return;
    resolvedPatient.set(request, visit?.patientId ?? UNRESOLVED_PATIENT);
    await visitScopeGuard(request, reply);
  };

  // 1 — list visits with filters.
  app.get(
    "/api/v1/visits",
    { preHandler: [READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(VisitListQuerySchema, request.query);
      return service.listVisits(
        organizationId,
        {
          clinician: q.clinician,
          patient: q.patient,
          from: q.from,
          to: q.to,
          status: q.status,
        },
        await readScope(request),
      );
    },
  );

  // 2 — fetch one visit.
  app.get(
    "/api/v1/visits/:visitId",
    {
      preHandler: [READ, VISIT_SCOPE],
      config: { auditRead: { resourceKind: "visit", resourceIdParam: "visitId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { visitId } = parse(VisitIdParamsSchema, request.params);
      return service.getVisit(organizationId, visitId);
    },
  );

  // 3 — direct manual create (skips the proposal path); runs the full D8 pre-schedule gate. GAP-093
  // re-attached `ABAC_CREDENTIALS` (`clinician_credentials_active`) now that a real `CredentialReader`
  // seam exists over the new `membership_credential` table (grant/revoke routes below give orgs a real
  // way to satisfy it — re-attaching without that would have 100%-denied this route again, the exact
  // GAP-030 regression this fix is careful not to reintroduce).
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

  // Candidate projection for the scheduling UI. This is advisory only: POST /visits retains every
  // RBAC/ABAC/domain gate, because eligibility can change between this read and the write.
  app.get("/api/v1/scheduling/eligible-clinicians", { preHandler: [CREATE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(EligibleCliniciansQuerySchema, request.query);
    return service.eligibleClinicians(organizationId, q);
  });

  // Minimal directory for scheduling readers.  Unlike the organization roster,
  // this does not require membership administration permission.
  app.get("/api/v1/scheduling/staff", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    return service.schedulingStaff(organizationId);
  });

  // 4 — edit non-lineage fields / assignment. Schedule time changes use the dedicated reschedule command.
  app.patch("/api/v1/visits/:visitId", { preHandler: [EDIT] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const b = parse(EditVisitRequest, request.body);
    return service.editVisit(organizationId, userId, visitId, b);
  });

  // GAP-050 — start / arrive are the clinician's own self-attest: the route predicate binds the acting
  // membership to the visit's assignee (the service re-checks), 403 on anyone else. An absent visit is a 404.
  const ASSIGNED_CLINICIAN: PreHandler = async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { visitId } = parse(VisitIdParamsSchema, request.params);
    const visit = await service.getVisit(organizationId, visitId);
    assertAssignedClinician(visit.assignedMembershipId, userId);
  };

  // 5 — self-attest start (EVV-missing path; an EVV-sourced start advances only from the M18 consumers).
  app.post(
    "/api/v1/visits/:visitId/start",
    { preHandler: [START, ASSIGNED_CLINICIAN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { visitId } = parse(VisitIdParamsSchema, request.params);
      const b = parse(StartVisitRequest, request.body);
      return service.startVisit(
        organizationId,
        userId,
        visitId,
        b.evvMissingReason,
        await requestStepUpFresh(request, START_STEP_UP_OPERATION),
      );
    },
  );

  // 6 — EVV/arrival check-in. This is the explicit en_route → in_visit step before encounter signature.
  app.post(
    "/api/v1/visits/:visitId/arrive",
    { preHandler: [START, ASSIGNED_CLINICIAN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { visitId } = parse(VisitIdParamsSchema, request.params);
      const b = parse(StartVisitRequest, request.body);
      return service.arriveVisit(
        organizationId,
        userId,
        visitId,
        b.evvMissingReason,
        // Server-side step-up freshness (#72) — the same EVV-missing self-attest gate as `start`; the
        // client-supplied `x-step-up` header this route read on main was the hole #70 closed.
        await requestStepUpFresh(request, START_STEP_UP_OPERATION),
      );
    },
  );

  // 7 — cancel a visit (reason ≥ 20 chars).
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
      return service.listProposals(
        organizationId,
        { patient: q.patient },
        await readScope(request),
      );
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
    return service.upsertAvailability(
      organizationId,
      userId,
      membershipId,
      b,
      await authorityOf(request),
    );
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
      const { organizationId, userId } = actorOf(request);
      const q = parse(TimeOffListQuerySchema, request.query);
      return service.listTimeOff(
        organizationId,
        userId,
        { membership: q.membership, state: q.state },
        await authorityOf(request),
      );
    },
  );

  // 19 — request PTO.
  app.post("/api/v1/time-off", { preHandler: [TIME_OFF_REQUEST] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(RequestTimeOffRequest, request.body);
    const res = await service.requestTimeOff(
      organizationId,
      userId,
      {
        membershipId: b.membershipId,
        kind: b.kind,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
      },
      await authorityOf(request),
    );
    return reply.code(201).send(res);
  });

  // 20 — approve PTO (triggers reassignment-scan in-service).
  app.post("/api/v1/time-off/:id/approve", { preHandler: [TIME_OFF_APPROVE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    parse(ApproveTimeOffRequest, request.body);
    return service.approveTimeOff(organizationId, userId, id, await authorityOf(request));
  });

  // 21 — deny PTO (reason ≥ 20 chars).
  app.post("/api/v1/time-off/:id/deny", { preHandler: [TIME_OFF_APPROVE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const b = parse(DenyTimeOffRequest, request.body);
    return service.denyTimeOff(organizationId, userId, id, b.reason, await authorityOf(request));
  });

  // 22 — cancel own pre-start PTO.
  app.post("/api/v1/time-off/:id/cancel", { preHandler: [TIME_OFF_CANCEL] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    parse(CancelTimeOffRequest, request.body);
    return service.cancelTimeOff(organizationId, userId, id, await authorityOf(request));
  });

  // 23 — day-view for a clinician or org-wide.
  app.get(
    "/api/v1/day-view",
    { preHandler: [READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(DayViewQuerySchema, request.query);
      return service.dayView(organizationId, q.membership, q.date, await readScope(request));
    },
  );

  // 24 — week-view.
  app.get(
    "/api/v1/week-view",
    { preHandler: [READ], config: { auditRead: { resourceKind: "visit", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(WeekViewQuerySchema, request.query);
      return service.weekView(organizationId, q.membership, q.weekStart, await readScope(request));
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
      return service.mapView(organizationId, q.membership, q.date, await readScope(request));
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
    {
      preHandler: [PORTAL_READ, PORTAL_GRANT],
      config: { auditRead: { resourceKind: "visit", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(PortalUpcomingQuerySchema, request.query);
      // GAP-132 — the portal session is pinned to one patient; a caller-named patient must be that patient.
      // Anything else (another patient, or an unpinned session) is a 404 — no existence oracle.
      const pinned = request.context?.attributes.sessionPatientId;
      if (typeof pinned !== "string" || pinned !== q.patient) throw new NotFoundError("patient");
      return service.portalUpcoming(organizationId, pinned, q.withinHours ?? 168);
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

  // 30/31/32 — GAP-093 membership-credential grant/revoke/list. The management surface the D8 gate
  // needs to be satisfiable at all — org-wide staff data, not caseload-scoped, so plain RBAC (no ABAC
  // predicate) gates these, matching the sibling `time_off.approve` shape.
  app.get(
    "/api/v1/memberships/:membershipId/credentials",
    {
      preHandler: [CREDENTIAL_READ],
      config: {
        auditRead: {
          none: "Staff clinical-license/certification roster only; no patient identifiers or PHI in the response.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { membershipId } = parse(MembershipIdParamsSchema, request.params);
      return service.listCredentials(organizationId, membershipId);
    },
  );

  app.post(
    "/api/v1/memberships/:membershipId/credentials",
    { preHandler: [CREDENTIAL_GRANT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { membershipId } = parse(MembershipIdParamsSchema, request.params);
      const b = parse(GrantCredentialRequest, request.body);
      const res = await service.grantCredential(organizationId, userId, {
        membershipId,
        credentialType: b.credentialType,
        effectiveAt: b.effectiveAt,
        expiresAt: b.expiresAt,
        issuingBody: b.issuingBody,
      });
      return reply.code(201).send(res);
    },
  );

  app.delete(
    "/api/v1/memberships/:membershipId/credentials/:credentialId",
    { preHandler: [CREDENTIAL_REVOKE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { credentialId } = parse(MembershipCredentialParamsSchema, request.params);
      const b = parse(RevokeCredentialRequest, request.body);
      await service.revokeCredential(organizationId, userId, credentialId, b.reason);
      return reply.code(204).send();
    },
  );
}
