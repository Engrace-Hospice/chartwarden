// apps/backend/src/modules/14-idg/routes/idg-routes.ts — M14-T05 the §4.1 route inventory behind the REAL
// Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the §4.6 keys M14
// registers into M3's catalog (M14_CONTRIBUTED_PERMISSIONS). Org binding is server-side (`request.context`,
// never the body). Handlers compose over the injected IdgRouteService (in-memory slice; Drizzle in prod under
// `withOrgContext` so RLS backstops).
//
// §4.7 wiring: per-meeting routes carry `requireAbac('idg_meeting_scope')` (target = the meeting `:id` /
// `:meetingId`); the decision-record route ALSO carries `requireAbac('quorate_decision')` (target = meeting
// `:id`); the cancel/reschedule routes ALSO carry `requireAbac('per_patient_review_floor_clear')` with a custom
// target lifting the body's `proposedTransition` + `newScheduledStart` (the audited override —
// `idg.override_review_floor` + step-up — is composed at the route). The location-scoped list routes
// (`GET /idg/schedule`, `GET /idg/action-items`) scope server-side (caller org/location/assignee) rather than
// through the meeting-specific predicate.
import {
  type AbacTarget,
  requireAbac,
  requirePermission,
  resolveActorPermissions,
} from "@wardenx/auth";
import { IDG_ATTENDANCE_DISCIPLINES, attendableDisciplinesForRoleKeys } from "@wardenx/idg";
import type { IdgActionItemStatus, IdgAttendanceStatus } from "@wardenx/types";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  WardenXError,
} from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestStepUpFresh } from "../../../bootstrap/index";
import { REVIEW_FLOOR_OVERRIDE_ATTRIBUTE } from "../abac-predicates";
import {
  type AttendanceTargetFacts,
  attendanceSelfOnlyError,
  planAttendanceRecord,
} from "./attendance-authority";
import {
  type IdgCaseloadResolver,
  assertIdgPatientInScope,
  filterIdgPatientsInScope,
  patientScopeFactsOf,
  seamIdgCaseloadResolver,
} from "./caseload-scope";
import { ifMatchVersionOf, requireIdempotencyKey, requireIfMatch } from "./concurrency";
import {
  type IdgRecertWindowFact,
  type IdgRouteEnrichmentPorts,
  withAuthorNames,
  withFinalizerName,
  withPatientDisplay,
} from "./idg-enrichment";
import {
  ActionItemListQuerySchema,
  AddAgendaItemRequest,
  AdjournMeetingRequest,
  AttendanceEligibilityQuerySchema,
  CancelMeetingRequest,
  CreateActionItemRequest,
  CreateDisciplineNoteRequest,
  DisciplineNoteListQuerySchema,
  IdParamsSchema,
  MeetingPacketParamsSchema,
  PatientIdParamsSchema,
  RecordAttendanceRequest,
  RecordDecisionRequest,
  RecurringPolicyRequest,
  RescheduleMeetingRequest,
  ScheduleMeetingRequest,
  ScheduleQuerySchema,
  SubmitAmendmentRequest,
  SupersedeDecisionRequest,
  UpdateActionItemRequest,
  UpdateAgendaItemRequest,
  UpdateAttendanceRequest,
  UpdateDecisionRequest,
  UpdateDisciplineNoteRequest,
  parse,
} from "./idg-typebox";
import {
  type PacketDisclosurePort,
  seamPacketDisclosurePort,
  sudDisclosureAllowedForPacket,
} from "./packet-disclosure";
import type { IdgRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface IdgRouteDeps {
  service: IdgRouteService;
  /**
   * Optional read-enrichment ports (patient display info; meeting-scoped recert/F2F windows), bound to M5/M6's
   * org-explicit seams at the composition root — see ./idg-enrichment.ts. Absent in the in-memory slice/tests.
   */
  enrichment?: IdgRouteEnrichmentPorts;
  /**
   * W-SUD-01 caller verdict for the packet READ (M39 `evaluateForInternalAccess`, per actor). Defaults to the
   * seam-registry-backed, fail-closed port — an unbound M39 REDACTS. Injected in tests.
   */
  sudDisclosure?: PacketDisclosurePort;
  /**
   * GAP-128 — the per-patient caseload resolver for the packet read and idg-history. Defaults to M5's published
   * `CaseloadProvider` seam (an unbound seam fails closed for non-org-wide roles). Injected in tests.
   */
  caseload?: IdgCaseloadResolver;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the acting MEMBERSHIP id (see idg-route-service-db.ts's own header comment:
  // "the acting membership is the passed `userId`, stored on coordinator/recorded_by/etc.") — every
  // downstream write lands it in a `*_membership_id` column. This used to read `ctx.userId` (the
  // raw Better Auth user id, a different id space), FK-violating every write.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("idg.read");
const ATTEND = P("idg.attend");
const COORDINATE = P("idg.coordinate");
const DECIDE = P("idg.decide");
const ACT = P("idg.act");
const SCHEDULE = P("idg.schedule");
const AMEND = P("idg.amend_minutes");

// §4.7 ABAC guards. `idg_meeting_scope` defaults its target to the route params (`:id` / `:meetingId`).
const SCOPE = (action: string): PreHandler =>
  requireAbac(action, "idg_meeting_scope") as PreHandler;
/**
 * Discipline-note WRITE gate (spec extension): the caller needs `idg.attend` (a participant) OR `idg.coordinate`
 * (any-discipline). Which of the two they hold decides {@link DisciplineNoteActor.isCoordinator}; the finer
 * "present for THIS discipline" rule is enforced in the service against the attendance roster.
 */
const NOTE_WRITE: PreHandler = async (request) => {
  const ctx = request.context;
  if (!ctx?.organizationId) throw new UnauthorizedError();
  const granted = await resolveActorPermissions(ctx);
  if (!granted.has("idg.attend") && !granted.has("idg.coordinate")) {
    throw new ForbiddenError("requires permission 'idg.attend' or 'idg.coordinate'");
  }
};
/** GAP-043: supersede names the TARGET meeting in the body (`meetingId`); the `:id` param is the DECISION, so the
 * meeting-scoped predicates must read the meeting from the body, not the params. A missing/non-string id yields
 * no meeting → the predicate denies (fail-closed). */
const supersedeTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const body = (request.body ?? {}) as { meetingId?: unknown };
  return typeof body.meetingId === "string" ? { id: body.meetingId } : {};
};
/** Validate params + body BEFORE the body-derived ABAC target is read, so a malformed request is the honest 422
 * rather than a misleading 403 from a predicate that saw no meeting id. */
const SUPERSEDE_VALIDATE: PreHandler = async (request) => {
  parse(IdParamsSchema, request.params);
  parse(SupersedeDecisionRequest, request.body);
};
const SUPERSEDE_SCOPE = requireAbac("idg.decide", "idg_meeting_scope", {
  getTarget: supersedeTarget,
  notFoundOnDeny: true,
}) as PreHandler;
const SUPERSEDE_QUORATE = requireAbac("idg.decide", "quorate_decision", {
  getTarget: supersedeTarget,
}) as PreHandler;
/** The PRIOR decision's own meeting must also be in the caller's scope (the target-meeting gate above does not cover
 * it: a coordinator at location A could otherwise supersede a location-B decision by naming an A meeting). The
 * decision id carries no meeting, so it is resolved first; unknown/cross-tenant decision and an out-of-scope
 * meeting are both the non-leaking 404, and an active break-glass grant cannot stand in for this gate. */
const SUPERSEDE_PRIOR_SCOPE = (service: IdgRouteService): PreHandler => {
  return async (request, reply) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    const meetingId = await service.decisionMeetingId(organizationId, id);
    if (meetingId === null) throw new NotFoundError("idg_decision");
    await (
      requireAbac("idg.decide", "idg_meeting_scope", {
        getTarget: () => ({ meetingId }),
        notFoundOnDeny: true,
        breakGlassBypassable: false,
      }) as PreHandler
    )(request, reply);
  };
};
const IF_MATCH = requireIfMatch();
const IDEMPOTENCY_KEY = requireIdempotencyKey();
const ABAC_QUORATE = requireAbac("idg.decide", "quorate_decision") as PreHandler;

// The cancel/reschedule target pins the transition from the ROUTE (cancel route => "cancel", reschedule route
// => "reschedule") and lifts only `newScheduledStart` from the body; the meeting `:id` comes from the params.
// The transition MUST NOT be read from the body: the body is not schema-validated until the handler runs, so a
// body missing `proposedTransition` used to be denied by the predicate (fail-closed on "unknown transition")
// as a misleading 403 before the 422 validation could fire — even for an empty-agenda meeting.
const reviewFloorTarget =
  (transition: "cancel" | "reschedule") =>
  (request: { readonly params?: unknown; readonly body?: unknown }): AbacTarget => {
    const params = (request.params ?? {}) as { id?: unknown };
    const body = (request.body ?? {}) as { newScheduledStart?: unknown };
    const target: Record<string, unknown> = { proposedTransition: transition };
    if (typeof params.id === "string") target.id = params.id;
    if (transition === "reschedule" && typeof body.newScheduledStart === "string")
      target.newScheduledStart = body.newScheduledStart;
    return target;
  };
const ABAC_REVIEW_FLOOR_CANCEL = requireAbac("idg.schedule", "per_patient_review_floor_clear", {
  getTarget: reviewFloorTarget("cancel"),
}) as PreHandler;
const ABAC_REVIEW_FLOOR_RESCHEDULE = requireAbac("idg.schedule", "per_patient_review_floor_clear", {
  getTarget: reviewFloorTarget("reschedule"),
}) as PreHandler;

/** GAP-091 — `per_patient_review_floor_clear` flags `context.attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]`
 * when it allowed a real breach through the audited `idg.override_review_floor` + step-up escape valve
 * (abac-predicates.ts). The handler reads it here to tell the service this was an override, so the service
 * records it (`m14.review_floor.override_recorded`) instead of silently proceeding. */
const reviewFloorOverrideOf = (request: FastifyRequest): boolean =>
  request.context?.attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE] === true;

/**
 * The fresh step-up assertion the ADJOURN route requires (§2.2 D13).
 *
 * This used to read `request.headers["x-step-up"] === "fresh"` — a CLIENT-SUPPLIED string, so any caller
 * who could reach the commit point could satisfy D13 by typing the header (F-028). It now resolves the
 * REAL session state through M2's `SessionContextResolver` seam, the same server-verified mechanism M3's
 * `step_up_recent` predicate uses and the one this module's own §4.7 predicate already called "the SAME
 * real, server-verified mechanism ... never a client-supplied header". The boolean (rather than a
 * `requireStepUp` preHandler) is kept because the pure `transitionMeeting` machine raises its own
 * `STEP_UP_REQUIRED` for it — a preHandler would move the refusal off the state machine that owns it.
 */
const ADJOURN_STEP_UP_OPERATION = "idg.meeting.adjourn";

export function registerIdgRoutes(app: FastifyInstance, deps: IdgRouteDeps): void {
  const { service } = deps;
  const patientDisplay = deps.enrichment?.patientDisplay;
  const recertPort = deps.enrichment?.recertWindows;
  const membershipDisplay = deps.enrichment?.membershipDisplay;
  const sudDisclosure = deps.sudDisclosure ?? seamPacketDisclosurePort;
  const caseload = deps.caseload ?? seamIdgCaseloadResolver;

  // 1 — list the meeting schedule for a location/range (location-scoped server-side).
  app.get(
    "/api/v1/idg/schedule",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "idg_meeting", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ScheduleQuerySchema, request.query);
      return service.listSchedule(organizationId, { location: q.location, from: q.from, to: q.to });
    },
  );

  // 2 — create a recurring policy (tenant-admin scope).
  app.post("/api/v1/idg/recurring-policies", { preHandler: [SCHEDULE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(RecurringPolicyRequest, request.body);
    const res = await service.createRecurringPolicy(organizationId, userId, b);
    return reply.code(201).send(res);
  });

  // 3 — update a recurring policy.
  app.patch(
    "/api/v1/idg/recurring-policies/:id",
    { preHandler: [SCHEDULE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RecurringPolicyRequest, request.body);
      return service.updateRecurringPolicy(
        organizationId,
        userId,
        id,
        b,
        ifMatchVersionOf(request),
      );
    },
  );

  // 3b — schedule ONE ad-hoc meeting (§4.1; the recurring worker is the only other creator). Location scope
  // is enforced here (the create has no meeting `:id` for `idg_meeting_scope` to resolve): a location outside
  // the caller's session location memberships is a 404 (no existence oracle), same non-leak as RLS-hidden rows.
  app.post("/api/v1/idg/meetings", { preHandler: [SCHEDULE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(ScheduleMeetingRequest, request.body);
    if (!request.context?.locationIds.includes(b.locationId)) throw new NotFoundError("location");
    const res = await service.scheduleMeeting(organizationId, userId, b);
    return reply.code(201).send(res);
  });

  // 4 — read one meeting.
  app.get(
    "/api/v1/idg/meetings/:id",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_meeting", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getMeeting(organizationId, id);
    },
  );

  // 5 — cancel a meeting (per_patient_review_floor_clear ABAC; override composed at the route).
  app.post(
    "/api/v1/idg/meetings/:id/cancel",
    { preHandler: [SCHEDULE, SCOPE("idg.schedule"), ABAC_REVIEW_FLOOR_CANCEL] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(CancelMeetingRequest, request.body);
      return service.cancelMeeting(
        organizationId,
        userId,
        id,
        b.reason,
        reviewFloorOverrideOf(request),
      );
    },
  );

  // 6 — reschedule a meeting (per_patient_review_floor_clear ABAC; override composed at the route).
  app.post(
    "/api/v1/idg/meetings/:id/reschedule",
    { preHandler: [SCHEDULE, SCOPE("idg.schedule"), ABAC_REVIEW_FLOOR_RESCHEDULE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RescheduleMeetingRequest, request.body);
      return service.rescheduleMeeting(organizationId, userId, id, {
        reason: b.reason,
        newScheduledStart: b.newScheduledStart,
        newScheduledEnd: b.newScheduledEnd,
        overrideAuthorized: reviewFloorOverrideOf(request),
      });
    },
  );

  // 7 — trigger the packet build.
  app.post(
    "/api/v1/idg/meetings/:id/packets/build",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.buildPackets(organizationId, userId, id);
    },
  );

  // 8 — start the meeting (opens the decision/action-item write path).
  app.post(
    "/api/v1/idg/meetings/:id/start",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.startMeeting(organizationId, userId, id);
    },
  );

  // 9 — adjourn the meeting (commit point; fresh step-up required, D13).
  app.post(
    "/api/v1/idg/meetings/:id/adjourn",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(AdjournMeetingRequest, request.body);
      return service.adjournMeeting(
        organizationId,
        userId,
        id,
        await requestStepUpFresh(request, ADJOURN_STEP_UP_OPERATION),
      );
    },
  );

  // ATTENDANCE TRUST (0286): what a member's AUTHORITATIVE roles let them attend as. The caller's own roles come from
  // the session context (the same authority every ABAC predicate reads); another member's come from M3's role-key seam,
  // called BEFORE any transaction opens (the seam takes its own connection). `unavailable` fails CLOSED.
  const membershipRoles = deps.enrichment?.membershipRoles;
  async function attendanceTargetFacts(
    request: FastifyRequest,
    organizationId: string,
    actorMembershipId: string,
    targetMembershipId: string,
  ): Promise<AttendanceTargetFacts> {
    if (targetMembershipId === actorMembershipId) {
      return {
        kind: "held",
        disciplines: attendableDisciplinesForRoleKeys(request.context?.roles ?? []),
      };
    }
    if (!membershipRoles) return { kind: "unavailable" };
    try {
      const byId = await membershipRoles.roleKeysForMemberships(organizationId, [
        targetMembershipId,
      ]);
      const keys = byId.get(targetMembershipId);
      return keys === undefined
        ? { kind: "not_found" }
        : { kind: "held", disciplines: attendableDisciplinesForRoleKeys(keys) };
    } catch (err) {
      request.log.warn({ err }, "idg: member role lookup failed; refusing the attendance write");
      return { kind: "unavailable" };
    }
  }

  // 10 — attendance check-in. A non-coordinator records ONLY themself (403 ATTENDANCE_SELF_ONLY); the discipline is
  // validated against the target's authoritative roles (422 DISCIPLINE_NOT_HELD); a coordinator may record others and,
  // with `coordinatorAttested`, an unheld discipline as a flagged override (see `planAttendanceRecord`).
  app.post(
    "/api/v1/idg/meetings/:id/attendance",
    { preHandler: [ATTEND, SCOPE("idg.attend")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RecordAttendanceRequest, request.body);
      const actorIsCoordinator = (await resolveActorPermissions(request.context!)).has(
        "idg.coordinate",
      );
      // A non-coordinator recording someone else is refused BEFORE any role lookup (no oracle on other members' roles).
      if (!actorIsCoordinator && b.membershipId !== userId) throw attendanceSelfOnlyError();
      const plan = planAttendanceRecord({
        actorMembershipId: userId,
        actorIsCoordinator,
        targetMembershipId: b.membershipId,
        discipline: b.discipline,
        coordinatorAttested: b.coordinatorAttested === true,
        target: await attendanceTargetFacts(request, organizationId, userId, b.membershipId),
      });
      const res = await service.recordAttendance(organizationId, userId, id, {
        membershipId: b.membershipId,
        discipline: b.discipline,
        status: b.status as IdgAttendanceStatus | undefined,
        checkedInAt: b.checkedInAt,
        recordedByMembershipId: userId,
        disciplineAttested: plan.disciplineAttested,
      });
      return reply.code(201).send(res);
    },
  );

  // 10b — what may the caller attest at the check-in? The caller's own held disciplines (from the session's roles), or,
  // for a coordinator passing `?membershipId=`, another member's (from the M3 seam) plus the vocabulary they may attest.
  app.get(
    "/api/v1/idg/meetings/:id/attendance-eligibility",
    {
      preHandler: [ATTEND, SCOPE("idg.attend")],
      config: {
        auditRead: {
          none: "staff role-derived attendance eligibility (discipline vocabulary), not patient data",
        },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      parse(IdParamsSchema, request.params);
      const q = parse(AttendanceEligibilityQuerySchema, request.query);
      const isCoordinator = (await resolveActorPermissions(request.context!)).has("idg.coordinate");
      const subject = q.membershipId ?? userId;
      if (subject !== userId && !isCoordinator) throw attendanceSelfOnlyError();
      const facts = await attendanceTargetFacts(request, organizationId, userId, subject);
      if (facts.kind === "not_found") {
        throw new WardenXError(
          "ATTENDANCE_MEMBERSHIP_NOT_FOUND",
          "that membership is not an active member of this organization",
          422,
        );
      }
      if (facts.kind === "unavailable") {
        throw new WardenXError(
          "ATTENDANCE_AUTHORITY_UNAVAILABLE",
          "could not verify the attendee's disciplines; please retry",
          503,
        );
      }
      return {
        membershipId: subject,
        isCoordinator,
        heldDisciplines: [...facts.disciplines],
        // A coordinator may attest anything in the vocabulary for ANOTHER member, never for themself.
        attestableDisciplines:
          isCoordinator && subject !== userId ? [...IDG_ATTENDANCE_DISCIPLINES] : [],
      };
    },
  );

  // 11 — coordinator amends an attendance row.
  app.patch(
    "/api/v1/idg/attendance/:id",
    { preHandler: [COORDINATE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(UpdateAttendanceRequest, request.body);
      return service.updateAttendance(
        organizationId,
        userId,
        id,
        b.status as IdgAttendanceStatus,
        ifMatchVersionOf(request),
      );
    },
  );

  // 12 — coordinator removes an erroneous attendance row (pre-start only; enforced in service).
  app.delete(
    "/api/v1/idg/attendance/:id",
    { preHandler: [COORDINATE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.removeAttendance(organizationId, userId, id, ifMatchVersionOf(request));
    },
  );

  // 12b — list the meeting's attendance roster (F-062). The three attendance WRITES shipped without
  // one, so the §2.7 participation the `quorate_decision` predicate evaluates could be written, amended
  // and excused, and read back by nothing — no source for the live quorum gauge §5 is specified around,
  // and no way to evidence the §418.56 group composition the roster exists to record.
  app.get(
    "/api/v1/idg/meetings/:id/attendance",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_meeting", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.listAttendance(organizationId, id);
    },
  );

  // 13 — list a meeting's packets.
  app.get(
    "/api/v1/idg/meetings/:id/packets",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_packet", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return withPatientDisplay(
        patientDisplay,
        organizationId,
        await filterIdgPatientsInScope(
          patientScopeFactsOf(request),
          organizationId,
          await service.listPackets(organizationId, id),
          caseload,
        ),
        request.log,
      );
    },
  );

  // 14 — read one patient's packet (SUD redaction applied in the read path, W-SUD-01).
  app.get(
    "/api/v1/idg/meetings/:meetingId/packets/:patientId",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_packet", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { meetingId, patientId } = parse(MeetingPacketParamsSchema, request.params);
      await assertIdgPatientInScope(
        patientScopeFactsOf(request),
        organizationId,
        patientId,
        caseload,
      );
      // W-SUD-01: the per-actor Part 2 verdict is resolved lazily (only for a SUD-flagged patient) and the
      // elision happens in the service's read path, before the view is shaped — never a UI hide.
      const membershipId = request.context?.attributes.membershipId;
      const roles = request.context?.roles ?? [];
      const detail = await service.getPacket(organizationId, meetingId, patientId, {
        sudDisclosureAllowed: (pid) =>
          sudDisclosureAllowedForPacket(sudDisclosure, {
            organizationId,
            patientId: pid,
            membershipId: typeof membershipId === "string" ? membershipId : null,
            roles,
          }),
        // Sampled-audit stand-in (§8.1 `idg.sud_redaction_applied`): the read itself is already in the M4 read
        // log (`auditRead`); this records THAT redaction happened, with the count kept server-side only.
        onSudRedaction: ({ patientId: pid, redactedEntryCount }) =>
          request.log.info(
            { event: "idg.sud_redaction_applied", meetingId, patientId: pid, redactedEntryCount },
            "idg: packet content filtered per 42 CFR Part 2",
          ),
      });
      const [packet] = await withPatientDisplay(
        patientDisplay,
        organizationId,
        [detail],
        request.log,
      );
      return packet;
    },
  );

  // 14b — patient-scoped IDG review history (patient-chart "IDG History" tab). Gated by idg.read; no
  // per-meeting idg_meeting_scope ABAC (the target is a patient, not one meeting). Metadata only — no
  // packet/decision narrative — so there is no SUD payload to redact. A patient never on an agenda → empty.
  app.get(
    "/api/v1/patients/:patientId/idg-history",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "idg_history", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      await assertIdgPatientInScope(
        patientScopeFactsOf(request),
        organizationId,
        patientId,
        caseload,
      );
      return service.getPatientIdgHistory(organizationId, patientId);
    },
  );

  // 15 — add an agenda item.
  app.post(
    "/api/v1/idg/meetings/:id/agenda",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(AddAgendaItemRequest, request.body);
      const res = await service.addAgendaItem(organizationId, userId, id, {
        kind: b.kind,
        patientId: b.patientId,
      });
      return reply.code(201).send(res);
    },
  );

  // 16 — update an agenda item.
  app.patch(
    "/api/v1/idg/agenda/:id",
    { preHandler: [COORDINATE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(UpdateAgendaItemRequest, request.body);
      return service.updateAgendaItem(organizationId, userId, id, ifMatchVersionOf(request));
    },
  );

  // 17 — delete an agenda item.
  app.delete(
    "/api/v1/idg/agenda/:id",
    { preHandler: [COORDINATE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.removeAgendaItem(organizationId, userId, id, ifMatchVersionOf(request));
    },
  );

  // 17b — list the meeting's agenda in `sort_order` (F-062; add/update/remove had no reader).
  app.get(
    "/api/v1/idg/meetings/:id/agenda",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_meeting", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return withPatientDisplay(
        patientDisplay,
        organizationId,
        await service.listAgenda(organizationId, id),
        request.log,
      );
    },
  );

  // 18 — record a decision (quorate_decision ABAC; target = meeting :id).
  app.post(
    "/api/v1/idg/meetings/:id/decisions",
    { preHandler: [DECIDE, SCOPE("idg.decide"), ABAC_QUORATE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RecordDecisionRequest, request.body);
      const res = await service.recordDecision(organizationId, userId, id, {
        patientId: b.patientId,
        agendaItemId: b.agendaItemId,
        decisionKind: b.payload.kind,
        payload: b.payload,
      });
      return reply.code(201).send(res);
    },
  );

  // 19 — update an open decision (open status only; enforced in service).
  // `If-Match` carries the version the caller read (428 absent, 400 malformed, 412 STALE_VERSION when stale).
  app.patch(
    "/api/v1/idg/decisions/:id",
    { preHandler: [DECIDE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(UpdateDecisionRequest, request.body);
      return service.updateDecision(
        organizationId,
        userId,
        id,
        b.payload,
        ifMatchVersionOf(request),
      );
    },
  );

  // 20 — supersede a prior decision (a new row in a later meeting; §2.8).
  app.post(
    "/api/v1/idg/decisions/:id/supersede",
    {
      preHandler: [
        DECIDE,
        SUPERSEDE_VALIDATE,
        SUPERSEDE_PRIOR_SCOPE(service),
        SUPERSEDE_SCOPE,
        SUPERSEDE_QUORATE,
      ],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(SupersedeDecisionRequest, request.body);
      // GAP-043: the successor lands in `b.meetingId` (a later, live, quorate meeting). The route gates on the
      // TARGET meeting's quorum (`quorate_decision`) and scope; the service re-derives both from stored facts.
      const res = await service.supersedeDecision(organizationId, userId, id, {
        meetingId: b.meetingId,
        callerLocationIds: request.context?.locationIds ?? [],
      });
      return reply.code(201).send(res);
    },
  );

  // 20b — the meeting's decision ledger, newest first (F-062). record/update/supersede all wrote to
  // `idg_decision` and the module's only reader was the PATIENT-scoped history tab, which answers "what
  // was decided about this patient across meetings". Nothing could answer "what did THIS meeting
  // decide" — the question the live surface exists to ask and the one an adjournment commits to.
  // Metadata only (see `DecisionViewSchema`): the D4 payload stays off the wire.
  app.get(
    "/api/v1/idg/meetings/:id/decisions",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_decision", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return withPatientDisplay(
        patientDisplay,
        organizationId,
        await service.listDecisions(organizationId, id),
        request.log,
      );
    },
  );

  // 21 — create an action item.
  app.post(
    "/api/v1/idg/meetings/:id/action-items",
    { preHandler: [COORDINATE, SCOPE("idg.coordinate")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(CreateActionItemRequest, request.body);
      // F-104 — the two D8 link fields travel together or not at all. A kind with no id can never be
      // matched when the artifact closes, and an id with no kind is matched by nothing: either alone
      // produces an item that LOOKS linked and will stay open forever, which is the failure the
      // auto-close engine exists to prevent. 422 rather than a silent null.
      if ((b.linkedArtifactKind === undefined) !== (b.linkedArtifactId === undefined)) {
        throw new ValidationError(
          "linkedArtifactKind and linkedArtifactId must be supplied together",
          [
            {
              field: b.linkedArtifactId === undefined ? "linkedArtifactId" : "linkedArtifactKind",
              code: "LINKED_ARTIFACT_INCOMPLETE",
              message:
                "a half-linked action item can never auto-close: the kind is what the D8 consumer matches on and the id is what it confirms",
            },
          ],
        );
      }
      const res = await service.createActionItem(organizationId, userId, id, {
        decisionId: b.decisionId,
        patientId: b.patientId,
        assignedToMembershipId: b.assignedToMembershipId,
        dueDate: b.dueDate,
        linkedArtifactKind: b.linkedArtifactKind,
        linkedArtifactId: b.linkedArtifactId,
      });
      return reply.code(201).send(res);
    },
  );

  // 22 — update an action item (assignee self-service via idg.act, or coordinator).
  app.patch(
    "/api/v1/idg/action-items/:id",
    { preHandler: [ACT, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(UpdateActionItemRequest, request.body);
      const isCoordinator = (await resolveActorPermissions(request.context!)).has("idg.coordinate");
      return service.updateActionItem(
        organizationId,
        userId,
        id,
        b.status,
        isCoordinator,
        ifMatchVersionOf(request),
      );
    },
  );

  // 23 — delete an action item (pre-adjourn only; enforced in service).
  app.delete(
    "/api/v1/idg/action-items/:id",
    { preHandler: [COORDINATE, IF_MATCH, IDEMPOTENCY_KEY] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.removeActionItem(organizationId, userId, id, ifMatchVersionOf(request));
    },
  );

  // 24 — list action items (assignee self-scoped; location-scoped server-side).
  app.get(
    "/api/v1/idg/action-items",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "idg_action_item", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const q = parse(ActionItemListQuerySchema, request.query);
      return withPatientDisplay(
        patientDisplay,
        organizationId,
        await service.listActionItems(organizationId, userId, {
          assignee: q.assignee,
          status: q.status as IdgActionItemStatus | undefined,
        }),
        request.log,
      );
    },
  );

  // 24b — the meeting's recert / face-to-face windows, one row per agenda patient (the IDG right pane). The
  // existing M6 reads are keyed by ADMISSION; a meeting has PATIENTS. The patient set is the agenda's
  // patient-scoped items UNION the built packets (packets are authoritative once built; agenda items are the
  // pre-build signal — the same split `patientIncluded` draws). The facts are SEAM-PULLED from M6 (§1.1 "recert/
  // F2F windows via M6 readers"): M6's own window math in the org timezone, one batched read for the whole
  // meeting. Same gate as the other per-meeting reads (idg.read + idg_meeting_scope → 404 non-leak).
  app.get(
    "/api/v1/idg/meetings/:id/recert-windows",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_meeting", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const [agenda, packets] = await Promise.all([
        service.listAgenda(organizationId, id),
        service.listPackets(organizationId, id),
      ]);
      const patientIds = [
        ...new Set([
          ...agenda.map((a) => a.patientId).filter((p): p is string => p !== null),
          ...packets.map((p) => p.patientId),
        ]),
      ];
      let windows: ReadonlyMap<string, IdgRecertWindowFact> = new Map();
      if (recertPort !== undefined && patientIds.length > 0) {
        try {
          windows = await recertPort.recertWindowsForPatients(organizationId, patientIds);
        } catch (err) {
          // An M6 read failure degrades to "unknown" rows (never a fabricated verdict, never a 500 on the screen).
          request.log.warn({ err }, "idg: recert-window read failed; returning unknown windows");
        }
      }
      const rows = patientIds.map((patientId) => {
        const w = windows.get(patientId);
        return {
          patientId,
          admissionId: w?.admissionId ?? null,
          currentPeriodSequence: w?.currentPeriodSequence ?? null,
          benefitPeriodStart: w?.benefitPeriodStart ?? null,
          benefitPeriodEnd: w?.benefitPeriodEnd ?? null,
          nextRecertDueDate: w?.nextRecertDueDate ?? null,
          nextPeriodSequence: w?.nextPeriodSequence ?? null,
          daysUntilNextRecert: w?.daysUntilNextRecert ?? null,
          f2fRequired: w?.f2fRequired ?? null,
          f2fWindowStart: w?.f2fWindowStart ?? null,
          f2fWindowEnd: w?.f2fWindowEnd ?? null,
          f2fStatus: w?.f2fStatus ?? ("unknown" as const),
          f2fWindowState: w?.f2fWindowState ?? null,
          f2fScheduledDate: w?.f2fScheduledDate ?? null,
        };
      });
      return {
        meetingId: id,
        generatedAt: new Date().toISOString(),
        items: await withPatientDisplay(patientDisplay, organizationId, rows, request.log),
      };
    },
  );

  // 24c — per-discipline meeting notes (spec extension; the M14 spec has only agenda body text + the closing
  // note). Reads: idg.read + idg_meeting_scope (404 non-leak), any meeting status (frozen after adjourn). The
  // W-SUD-01 caller verdict is resolved lazily per SUD-flagged/undeterminable patient; without a Part 2 release
  // the note's text is withheld (`bodyWithheld`), fail-closed. The audit row is the M4 read log (`auditRead`).
  app.get(
    "/api/v1/idg/meetings/:id/discipline-notes",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: {
        auditRead: { resourceKind: "idg_discipline_note", resourceIdParam: "id", list: true },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const q = parse(DisciplineNoteListQuerySchema, request.query);
      const membershipId = request.context?.attributes.membershipId;
      const roles = request.context?.roles ?? [];
      const notes = await service.listDisciplineNotes(
        organizationId,
        id,
        { patientId: q.patientId },
        {
          sudDisclosureAllowed: (pid) =>
            sudDisclosureAllowedForPacket(sudDisclosure, {
              organizationId,
              patientId: pid,
              membershipId: typeof membershipId === "string" ? membershipId : null,
              roles,
            }),
          onSudRedaction: ({ patientId: pid }) =>
            request.log.info(
              {
                event: "idg.sud_redaction_applied",
                meetingId: id,
                patientId: pid,
                surface: "discipline_note",
              },
              "idg: discipline note text withheld per 42 CFR Part 2",
            ),
        },
      );
      return withAuthorNames(
        membershipDisplay,
        organizationId,
        await withPatientDisplay(patientDisplay, organizationId, notes, request.log),
        request.log,
      );
    },
  );

  // 24d — write a discipline note. A `live` meeting takes ordinary notes; an `adjourned` one (within the addendum
  // window, with a required `reason`) takes a LATE ADDENDUM — a new append-only row that never touches the frozen
  // minutes snapshot; other states => 422 MEETING_NOT_LIVE, out of window => 422 ADDENDUM_WINDOW_CLOSED, a patient
  // already included by a NEWER adjourned IDG => 422 ADDENDUM_SUPERSEDED_BY_NEWER_IDG (503 ADDENDUM_ELIGIBILITY_UNAVAILABLE
  // if that lookup fails), missing reason => 422 ADDENDUM_REASON_REQUIRED. On a live meeting `reason` is optional context. A coordinator may write any
  // discipline, everyone else only for a discipline they are recorded present for (403); a patient must be on
  // the meeting's agenda/packet set (422). Idempotency-Key required.
  app.post(
    "/api/v1/idg/meetings/:id/discipline-notes",
    { preHandler: [NOTE_WRITE, SCOPE("idg.attend"), IDEMPOTENCY_KEY] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(CreateDisciplineNoteRequest, request.body);
      const isCoordinator = (await resolveActorPermissions(request.context!)).has("idg.coordinate");
      const note = await service.createDisciplineNote(
        organizationId,
        { membershipId: userId, isCoordinator },
        id,
        {
          patientId: b.patientId ?? null,
          discipline: b.discipline,
          bodyText: b.bodyText,
          reason: b.reason ?? null,
        },
      );
      const [out] = await withAuthorNames(membershipDisplay, organizationId, [note], request.log);
      return reply.code(201).send(out);
    },
  );

  // 24e — edit a note's text and/or reason (If-Match = the version read; 412 on skew; no delete). Only while the meeting is
  // `live`: original notes of an adjourned meeting are frozen (422 MEETING_NOT_LIVE) and addenda are append-only
  // (422 ADDENDUM_IMMUTABLE — a correction is a further addendum). The note id carries no
  // meeting id, so the SAME `idg_meeting_scope` predicate is evaluated here against the note's OWNING meeting
  // (resolved first; an unknown/cross-tenant note is the non-leaking 404).
  app.patch(
    "/api/v1/idg/discipline-notes/:id",
    {
      preHandler: [
        NOTE_WRITE,
        IDEMPOTENCY_KEY,
        IF_MATCH,
        async (request, reply) => {
          const { organizationId } = actorOf(request);
          const { id } = parse(IdParamsSchema, request.params);
          const meetingId = await service.disciplineNoteMeetingId(organizationId, id);
          if (meetingId === null) throw new NotFoundError("idg_discipline_note");
          await (
            requireAbac("idg.attend", "idg_meeting_scope", {
              getTarget: () => ({ meetingId }),
            }) as PreHandler
          )(request, reply);
        },
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(UpdateDisciplineNoteRequest, request.body);
      const isCoordinator = (await resolveActorPermissions(request.context!)).has("idg.coordinate");
      const note = await service.updateDisciplineNote(
        organizationId,
        { membershipId: userId, isCoordinator },
        id,
        {
          ...(b.bodyText !== undefined ? { bodyText: b.bodyText } : {}),
          ...(b.reason !== undefined ? { reason: b.reason } : {}),
        },
        ifMatchVersionOf(request),
      );
      const [out] = await withAuthorNames(membershipDisplay, organizationId, [note], request.log);
      return out;
    },
  );

  // 25 — read a meeting's minutes.
  app.get(
    "/api/v1/idg/meetings/:id/minutes",
    {
      preHandler: [READ, SCOPE("idg.read")],
      config: { auditRead: { resourceKind: "idg_minutes", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return withFinalizerName(
        membershipDisplay,
        organizationId,
        await service.getMinutes(organizationId, id),
        request.log,
      );
    },
  );

  // 26 — submit a minutes amendment (final minutes only; tenant-admin / compliance scope).
  app.post(
    "/api/v1/idg/minutes/:id/amendments",
    { preHandler: [AMEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(SubmitAmendmentRequest, request.body);
      const res = await service.submitAmendment(organizationId, userId, id, b.amendmentReason);
      return reply.code(201).send(res);
    },
  );
}
