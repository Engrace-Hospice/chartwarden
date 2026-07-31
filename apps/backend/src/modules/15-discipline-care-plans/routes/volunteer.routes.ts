// apps/backend/src/modules/15-discipline-care-plans/routes/volunteer.routes.ts — M15 (§4.1) routes 17–24:
// the 42 CFR §418.78 volunteer surface — assignments, compliance gates and the 5% hour ledger.
//
// §4.5 binding: the coordinator-only routes (17, 18, 20, 21) compose `volunteer_coordinator_role`. The
// routes the §4.1 table gives an ∨-alternative to (19 / 22 / 23 / 24 — "Vol Coord ∨ Compliance Officer ∨
// DON") are gated by their §4.4 permission key ALONE: a named predicate is a single boolean, so encoding
// the disjunction as one would either lock a Compliance Officer out of a surface the spec grants them or
// widen the coordinator predicate into a role-union that no longer means what M17 reads it for. The role
// disjunction lives where it belongs — in the key's role-template grants (§6 permissions matrix).
//
// Route 17 composes `volunteer_compliance_active` only when NO documented override is supplied (§8.6): the
// override path must reach the handler so the ≥40-char reason is enforced and the failing gates are
// recorded rather than the request being refused by an opaque 403.
import type { FastifyInstance } from "fastify";
import { writeActorOf, actorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_COORDINATOR, ABAC_VOLUNTEER_ACTIVE_UNLESS_OVERRIDE, P } from "./guards";
import {
  AssignmentParams,
  CreateHourEntryBody,
  CreateVolunteerAssignmentBody,
  CreateVolunteerGateBody,
  GateListQuerySchema,
  GateParams,
  HourRatioQuerySchema,
  PlanParams,
  RevokeVolunteerGateBody,
  UpdateVolunteerAssignmentBody,
  UpdateVolunteerGateBody,
  parse,
  parseQuery,
} from "./m15-typebox";
import type { M15ReadService } from "./read-service";
import type { M15WriteService } from "./write-service";

export interface VolunteerRouteDeps {
  readonly readService: M15ReadService;
  readonly writeService: M15WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

export function registerVolunteerRoutes(app: FastifyInstance, deps: VolunteerRouteDeps): void {
  const { readService, writeService } = deps;

  // 17 — create a volunteer assignment (the §7.4 418.78 gate check, with the §8.6 audited override).
  app.post(
    "/api/v1/discipline-plans/:planId/volunteer-assignments",
    {
      preHandler: [
        P("volunteer_assignment.author"),
        ABAC_COORDINATOR("volunteer_assignment.author"),
        ABAC_VOLUNTEER_ACTIVE_UNLESS_OVERRIDE("volunteer_assignment.author"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CreateVolunteerAssignmentBody, request.body);
      const created = await writeService.createVolunteerAssignment(
        writeActorOf(request),
        planId,
        body,
      );
      return reply.code(201).send(created);
    },
  );

  // 18 — edit / inactivate / reactivate an assignment (§7.5 — reactivation is always manual).
  app.patch(
    "/api/v1/discipline-plans/:planId/volunteer-assignments/:assignmentId",
    {
      preHandler: [
        P("volunteer_assignment.author"),
        ABAC_COORDINATOR("volunteer_assignment.author"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId, assignmentId } = parse(AssignmentParams, request.params);
      const body = parse(UpdateVolunteerAssignmentBody, request.body);
      return writeService.updateVolunteerAssignment(writeActorOf(request), planId, assignmentId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 19 — the compliance-gate worklist (cursor-paginated; status re-derived over the validity window).
  app.get(
    "/api/v1/volunteer-compliance-gates",
    {
      preHandler: [P("volunteer_compliance.read"), NO_OFFSET],
      config: {
        // A compliance gate is a WORKFORCE credential (a volunteer's TB screening, background check),
        // not patient data — no patient id is surfaced, so the §2.5 read-audit obligation is waived with
        // its justification rather than emitting a patient-less PHI read event.
        auditRead: {
          none: "volunteer workforce-credential rows; no patient-identifying field is surfaced",
        },
      },
    },
    async (request) =>
      readService.listVolunteerGates(actorOf(request), parseQuery(GateListQuerySchema, request.query)),
  );

  // 20 — record a gate.
  app.post(
    "/api/v1/volunteer-compliance-gates",
    {
      preHandler: [
        P("volunteer_compliance.author"),
        ABAC_COORDINATOR("volunteer_compliance.author"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const body = parse(CreateVolunteerGateBody, request.body);
      const created = await writeService.createVolunteerGate(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 21 — correct a recorded gate's window / evidence.
  app.patch(
    "/api/v1/volunteer-compliance-gates/:gateId",
    {
      preHandler: [
        P("volunteer_compliance.author"),
        ABAC_COORDINATOR("volunteer_compliance.author"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { gateId } = parse(GateParams, request.params);
      const body = parse(UpdateVolunteerGateBody, request.body);
      return writeService.updateVolunteerGate(writeActorOf(request), gateId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 22 — revoke a satisfied gate (Vol Coord ∨ Compliance Officer, per the key's role templates).
  app.post(
    "/api/v1/volunteer-compliance-gates/:gateId/revoke",
    { preHandler: [P("volunteer_compliance.revoke"), IDEMPOTENT] },
    async (request) => {
      const { gateId } = parse(GateParams, request.params);
      const body = parse(RevokeVolunteerGateBody, request.body);
      return writeService.revokeVolunteerGate(writeActorOf(request), gateId, {
        expectedVersion: ifMatchVersion(request, true),
        revokedReason: body.revokedReason,
      });
    },
  );

  // 23 — the 418.78(e) 5% ratio (single aggregate row; `unavailable` while the M27 hours seam is unbound).
  app.get(
    "/api/v1/volunteer-hour-ratio",
    {
      preHandler: [P("volunteer_compliance.read_ratio")],
      config: {
        auditRead: {
          none: "provider-entity-level volunteer-hour aggregate; no patient-identifying field is surfaced",
        },
      },
    },
    async (request) =>
      readService.getVolunteerHourRatio(actorOf(request), parseQuery(HourRatioQuerySchema, request.query)),
  );

  // 24 — a manual hour adjustment on the ledger (the ONLY path that may carry negative minutes).
  app.post(
    "/api/v1/volunteer-hour-entries",
    { preHandler: [P("volunteer_compliance.adjust_hours"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateHourEntryBody, request.body);
      const created = await writeService.createHourEntry(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );
}
