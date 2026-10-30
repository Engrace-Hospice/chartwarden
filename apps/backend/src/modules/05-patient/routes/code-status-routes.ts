// apps/backend/src/modules/05-patient/routes/code-status-routes.ts — the M5 patient code-status routes (ADR-0104).
//
//   GET  /api/v1/patients/:id/code-status                              patient.read             caseload_or_scope
//   POST /api/v1/patients/:id/code-status                              patient.edit_code_status caseload_or_scope
//   POST /api/v1/patients/:id/code-status/:entryId/entered-in-error    patient.edit_code_status caseload_or_scope
//
// The chart scope guard runs on `:id` for all three (404 on deny, no existence leak). A write needs a human membership
// on the request context — the actor the row records — so an AI principal or a membership-less session gets a 401.
import { type GuardRequest, requireAbac, requirePermission } from "@chartwarden/auth";
import { ChartWardenError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CodeStatusAlreadyEnteredInErrorError,
  CodeStatusEntryNotFoundError,
  CodeStatusPatientNotFoundError,
  CodeStatusSourceDocumentInvalidError,
  type PatientCodeStatusPort,
} from "../code-status";
import {
  CodeStatusParamsSchema,
  EnteredInErrorCodeStatusBodySchema,
  SetCodeStatusBodySchema,
} from "./code-status-typebox";
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
const EDIT = requirePermission("patient.edit_code_status") as PreHandler;
const SCOPE_READ = chartScope("patient.read");
const SCOPE_EDIT = chartScope("patient.edit_code_status");

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

function writerOf(request: FastifyRequest) {
  const { organizationId, userId } = actorOf(request);
  const m = request.context.attributes?.membershipId;
  if (typeof m !== "string" || m.length === 0) throw new UnauthorizedError();
  return { organizationId, actor: { userId, membershipId: m } };
}

/** Map the port's typed precondition errors onto the HTTP contract; anything else rethrows. */
function mapCodeStatusError(err: unknown): unknown {
  if (err instanceof CodeStatusPatientNotFoundError) {
    return new ChartWardenError("NOT_FOUND", "patient not found", 404);
  }
  if (err instanceof CodeStatusEntryNotFoundError) {
    return new ChartWardenError("NOT_FOUND", "code status entry not found", 404);
  }
  if (err instanceof CodeStatusAlreadyEnteredInErrorError) {
    return new ChartWardenError("CODE_STATUS_ALREADY_ENTERED_IN_ERROR", err.message, 409);
  }
  if (err instanceof CodeStatusSourceDocumentInvalidError) {
    return new ChartWardenError("CODE_STATUS_SOURCE_DOCUMENT_INVALID", err.message, 422);
  }
  return err;
}

export interface PatientCodeStatusRouteDeps {
  readonly codeStatus: PatientCodeStatusPort;
}

export function registerPatientCodeStatusRoutes(
  app: FastifyInstance,
  deps: PatientCodeStatusRouteDeps,
): void {
  const { codeStatus } = deps;

  app.get(
    "/api/v1/patients/:id/code-status",
    {
      preHandler: [READ, SCOPE_READ],
      // `resourceIdParam` is required: without it the read event's resource id is empty and the audit insert is
      // swallowed (.claude/rules/auth-and-audit.md).
      config: {
        auditRead: {
          resourceKind: "patient",
          patientIdParam: "id",
          resourceIdParam: "id",
          fields: ["code_status"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const list = await codeStatus.list(organizationId, id);
      if (list === null) throw new ChartWardenError("NOT_FOUND", "patient not found", 404);
      return list;
    },
  );

  app.post(
    "/api/v1/patients/:id/code-status",
    { preHandler: [EDIT, SCOPE_EDIT] },
    async (request, reply) => {
      const { organizationId, actor } = writerOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const body = parse(SetCodeStatusBodySchema, request.body);
      try {
        return reply.code(201).send(await codeStatus.set(organizationId, id, body, actor));
      } catch (err) {
        throw mapCodeStatusError(err);
      }
    },
  );

  app.post(
    "/api/v1/patients/:id/code-status/:entryId/entered-in-error",
    { preHandler: [EDIT, SCOPE_EDIT] },
    async (request) => {
      const { organizationId, actor } = writerOf(request);
      const { id, entryId } = parse(CodeStatusParamsSchema, request.params);
      const body = parse(EnteredInErrorCodeStatusBodySchema, request.body);
      try {
        return await codeStatus.enterInError(organizationId, id, entryId, body, actor);
      } catch (err) {
        throw mapCodeStatusError(err);
      }
    },
  );
}
