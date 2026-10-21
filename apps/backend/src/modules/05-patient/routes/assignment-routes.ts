// apps/backend/src/modules/05-patient/routes/assignment-routes.ts — the M5 §4.3 care-team assignment
// routes (GAP-015). Until now NO production code wrote `patient_assignment`, so durable caseload
// membership (the `caseload_or_scope` source) and the care-team lookups M8/M12/M13/M36 read could not be
// created in a real tenant.
//
//   GET  /api/v1/patients/:id/assignments                       patient.read    caseload_or_scope
//   POST /api/v1/patients/:id/assignments                       patient.assign  caseload_or_scope
//   POST /api/v1/patients/:id/assignments/:assignmentId/end     patient.assign  caseload_or_scope
//
// "Assigner must already have access" (spec): the chart scope guard runs on `:id` for all three, 404 on
// deny so a refusal never confirms the chart exists. Org-wide oversight roles (DON etc.) pass it through
// the predicate's org-wide arm, which is how the first clinician ever lands on a caseload.
import { type GuardRequest, requireAbac, requirePermission } from "@chartwarden/auth";
import { UnauthorizedError, ChartWardenError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AssignmentAlreadyEndedError,
  AssignmentAlreadyOpenError,
  AssignmentEndBeforeStartError,
  AssignmentNotFoundError,
  AssignmentPatientNotFoundError,
  ClinicianNotInOrgError,
  type PatientAssignmentsPort,
  PrimaryRnAlreadyAssignedError,
} from "../assignments";
import {
  AssignClinicianBodySchema,
  AssignmentParamsSchema,
  EndAssignmentBodySchema,
} from "./assignment-typebox";
import { LooseIdParamsSchema, parse } from "./patient-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const chartScope = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: (request: GuardRequest) => ({
      patientId: (request.params as { id?: unknown } | undefined)?.id,
    }),
    notFoundOnDeny: true,
  }) as PreHandler;

const READ = requirePermission("patient.read") as PreHandler;
const ASSIGN = requirePermission("patient.assign") as PreHandler;
const SCOPE_READ = chartScope("patient.read");
const SCOPE_ASSIGN = chartScope("patient.assign");

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Map the port's typed precondition errors onto the §4.3 HTTP contract; anything else rethrows. */
function mapAssignmentError(err: unknown): unknown {
  if (err instanceof AssignmentPatientNotFoundError) {
    return new ChartWardenError("NOT_FOUND", "patient not found", 404);
  }
  if (err instanceof AssignmentNotFoundError) {
    return new ChartWardenError("NOT_FOUND", "assignment not found", 404);
  }
  if (err instanceof PrimaryRnAlreadyAssignedError) {
    return new ChartWardenError("PRIMARY_RN_ALREADY_ASSIGNED", err.message, 409);
  }
  if (err instanceof AssignmentAlreadyOpenError) {
    return new ChartWardenError("ASSIGNMENT_ALREADY_OPEN", err.message, 409);
  }
  if (err instanceof AssignmentAlreadyEndedError) {
    return new ChartWardenError("ASSIGNMENT_ALREADY_ENDED", err.message, 409);
  }
  if (err instanceof ClinicianNotInOrgError) {
    return new ChartWardenError("CLINICIAN_NOT_IN_ORG", err.message, 422);
  }
  if (err instanceof AssignmentEndBeforeStartError) {
    return new ChartWardenError("ASSIGNMENT_END_BEFORE_START", err.message, 422);
  }
  return err;
}

export interface PatientAssignmentRouteDeps {
  readonly assignments: PatientAssignmentsPort;
}

export function registerPatientAssignmentRoutes(
  app: FastifyInstance,
  deps: PatientAssignmentRouteDeps,
): void {
  const { assignments } = deps;

  app.get(
    "/api/v1/patients/:id/assignments",
    {
      preHandler: [READ, SCOPE_READ],
      config: {
        auditRead: {
          resourceKind: "patient",
          patientIdParam: "id",
          fields: ["assignments"],
          list: true,
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const rows = await assignments.list(organizationId, id);
      if (rows === null) throw new ChartWardenError("NOT_FOUND", "patient not found", 404);
      return { assignments: rows };
    },
  );

  app.post(
    "/api/v1/patients/:id/assignments",
    { preHandler: [ASSIGN, SCOPE_ASSIGN] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(AssignClinicianBodySchema, request.body);
      try {
        return reply.code(201).send(await assignments.assign(organizationId, id, body, userId));
      } catch (err) {
        throw mapAssignmentError(err);
      }
    },
  );

  app.post(
    "/api/v1/patients/:id/assignments/:assignmentId/end",
    { preHandler: [ASSIGN, SCOPE_ASSIGN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, assignmentId } = parse(AssignmentParamsSchema, request.params);
      const body = parse(EndAssignmentBodySchema, request.body);
      try {
        return await assignments.end(organizationId, id, assignmentId, body, userId);
      } catch (err) {
        throw mapAssignmentError(err);
      }
    },
  );
}
