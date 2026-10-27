// apps/backend/src/modules/05-patient/routes/wristband-routes.ts -- the M5 patient wristband (GAP-020).
//
//   POST /api/v1/patients/:id/wristbands                       print / reprint (returns the raw payload ONCE)
//   GET  /api/v1/patients/:id/wristband                        chart badge: is there an active band
//   POST /api/v1/patients/:id/wristbands/:generation/void      hard-kill a generation (step-up)
//
// Guards mirror the allergy routes: a permission + M7's `caseload_or_scope` on `:id` (404 on deny, no
// existence leak). The issue route returns a ONE-TIME SECRET, so it opts out of `Idempotency-Key` capture
// (`config.noIdempotencyCapture`: the shared web client sends a key on every mutation, and capturing the response
// would copy the token into `idempotency_key.response_body`) and sets `Cache-Control: no-store`. Its double-submit
// protection is the `expectedCurrentGeneration` precondition inside one locked transaction.
import {
  type GuardRequest,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  getPatientWristbandStatus,
  issuePatientWristband,
  voidPatientWristband,
} from "../wristband-db";
import { parse } from "./patient-typebox";
import {
  IssueWristbandBodySchema,
  IssuedWristbandSchema,
  PatientIdParamsSchema,
  VoidWristbandBodySchema,
  WristbandParamsSchema,
  WristbandStatusSchema,
} from "./wristband-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const READ = requirePermission("patient.read") as PreHandler;
const ISSUE = requirePermission("patient.wristband.issue") as PreHandler;
const VOID = requirePermission("patient.wristband.void") as PreHandler;
const VOID_STEP_UP = requireStepUp("patient.wristband.void") as PreHandler;
const chartScope = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: (request: GuardRequest) => ({
      patientId: (request.params as { id?: unknown } | undefined)?.id,
    }),
    notFoundOnDeny: true,
  }) as PreHandler;
const SCOPE_READ = chartScope("patient.read");
const SCOPE_ISSUE = chartScope("patient.wristband.issue");
const SCOPE_VOID = chartScope("patient.wristband.void");

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export interface PatientWristbandRouteDeps {
  readonly db: DbClient;
}

export function registerPatientWristbandRoutes(
  app: FastifyInstance,
  deps: PatientWristbandRouteDeps,
): void {
  const { db } = deps;

  app.post(
    "/api/v1/patients/:id/wristbands",
    {
      preHandler: [ISSUE, SCOPE_ISSUE],
      config: { noIdempotencyCapture: true },
      schema: { response: { 201: IssuedWristbandSchema } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = parse(PatientIdParamsSchema, request.params);
      const body = parse(IssueWristbandBodySchema, request.body);
      const issued = await issuePatientWristband(db, actor, {
        patientId: id,
        reason: body.reason,
        expectedCurrentGeneration: body.expectedCurrentGeneration,
      });
      return reply.code(201).header("Cache-Control", "no-store").send(issued);
    },
  );

  app.get(
    "/api/v1/patients/:id/wristband",
    {
      preHandler: [READ, SCOPE_READ],
      config: {
        auditRead: { resourceKind: "patient", patientIdParam: "id", fields: ["wristband_status"] },
      },
      schema: { response: { 200: WristbandStatusSchema } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(PatientIdParamsSchema, request.params);
      return getPatientWristbandStatus(db, actor, id);
    },
  );

  app.post(
    "/api/v1/patients/:id/wristbands/:generation/void",
    { preHandler: [VOID, SCOPE_VOID, VOID_STEP_UP] },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, generation } = parse(WristbandParamsSchema, request.params);
      const body = parse(VoidWristbandBodySchema, request.body);
      await voidPatientWristband(db, actor, { patientId: id, generation, reason: body.reason });
      return reply.code(204).send();
    },
  );
}
