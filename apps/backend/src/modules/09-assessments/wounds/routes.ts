// apps/backend/src/modules/09-assessments/wounds/routes.ts — M9 longitudinal wound routes. A patient has wounds; each visit
// adds dated observations to a wound; a correction appends a superseding observation (the M9 convention: values are never
// updated). Behind the REAL Authorization Contract on the EXISTING M9 keys — `assessment.read` for reads,
// `assessment.author` to create / observe / resolve, `assessment.amend` to correct — each composed with the shared
// `caseload_or_scope` ABAC predicate (the patientId is in the path), as every other patient-scoped M9 route is. The
// discipline matrix (`discipline_can_record_scale`) is about scales and does not apply. Org and actor come from the
// server-assembled `request.context`, never the body. PHI reads carry a read-audit config naming the resource.
// Every write is a clinician's act: an AI principal is refused (403, D13), and the three that APPEND a row (register a wound, add an
// observation, correct one) require an `Idempotency-Key`, so a retry after a lost reply replays the first answer instead of recording
// a second open wound or a duplicate observation (the web client sends one on every mutating call).
import { requireAbac, requirePermission } from "@chartwarden/auth";
import {
  type PreHandler,
  ifMatchVersionOf,
  orgOf,
  rejectAiActor,
  requireIdempotencyKey,
  requireIfMatch,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WoundRouteService, WoundWriteActor } from "./service";
import {
  CorrectWoundObservationSchema,
  CreateWoundSchema,
  RecordWoundObservationSchema,
  ResolveWoundSchema,
  WoundDetailQuerySchema,
  WoundListQuerySchema,
  WoundObservationParamsSchema,
  WoundParamsSchema,
  WoundPatientParamsSchema,
  parse,
} from "./wounds-typebox";

export interface WoundRouteDeps {
  service: WoundRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("assessment.read");
const AUTHOR = P("assessment.author");
const AMEND = P("assessment.amend");
const SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "caseload_or_scope", { notFoundOnDeny: true }) as PreHandler;
const IF_MATCH = requireIfMatch() as PreHandler;
const IDEMPOTENT = requireIdempotencyKey() as PreHandler;
const NO_AI = rejectAiActor(
  "AI principals cannot record or change a wound (a clinician's assessment)",
) as PreHandler;

function writeActor(request: FastifyRequest): WoundWriteActor {
  const { organizationId, userId, membershipId } = writeActorOf(request);
  return { organizationId, userId, membershipId };
}

export function registerWoundRoutes(app: FastifyInstance, deps: WoundRouteDeps): void {
  const { service } = deps;

  // A patient's wounds, each with its latest observation (status filter; default all).
  app.get(
    "/api/v1/patients/:patientId/wounds",
    {
      preHandler: [READ, SCOPE_FOR("assessment.read")],
      config: { auditRead: { resourceKind: "wound", patientIdParam: "patientId", list: true } },
    },
    async (request) => {
      const organizationId = orgOf(request);
      const { patientId } = parse(WoundPatientParamsSchema, request.params);
      const { status } = parse(WoundListQuerySchema, request.query);
      return service.listWounds(organizationId, patientId, status ?? "all");
    },
  );

  // Register a wound.
  app.post(
    "/api/v1/patients/:patientId/wounds",
    { preHandler: [NO_AI, AUTHOR, SCOPE_FOR("assessment.author"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActor(request);
      const { patientId } = parse(WoundPatientParamsSchema, request.params);
      const body = parse(CreateWoundSchema, request.body);
      return reply.code(201).send(await service.createWound(actor, patientId, body));
    },
  );

  // One wound with its observations, newest first, each with the computed area and percent change.
  app.get(
    "/api/v1/patients/:patientId/wounds/:woundId",
    {
      preHandler: [READ, SCOPE_FOR("assessment.read")],
      config: {
        auditRead: {
          resourceKind: "wound",
          patientIdParam: "patientId",
          resourceIdParam: "woundId",
        },
      },
    },
    async (request) => {
      const organizationId = orgOf(request);
      const { patientId, woundId } = parse(WoundParamsSchema, request.params);
      const { includeSuperseded } = parse(WoundDetailQuerySchema, request.query);
      return service.getWound(organizationId, patientId, woundId, {
        includeSuperseded: includeSuperseded ?? false,
      });
    },
  );

  // Add a dated observation (may carry the encounter it was recorded at).
  app.post(
    "/api/v1/patients/:patientId/wounds/:woundId/observations",
    { preHandler: [NO_AI, AUTHOR, SCOPE_FOR("assessment.author"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActor(request);
      const { patientId, woundId } = parse(WoundParamsSchema, request.params);
      const body = parse(RecordWoundObservationSchema, request.body);
      return reply.code(201).send(await service.recordObservation(actor, patientId, woundId, body));
    },
  );

  // Correct an observation: appends one that supersedes it (If-Match = the version read; 409 STALE_VERSION on skew).
  app.post(
    "/api/v1/patients/:patientId/wounds/:woundId/observations/:observationId/corrections",
    { preHandler: [NO_AI, AMEND, SCOPE_FOR("assessment.amend"), IF_MATCH, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActor(request);
      const { patientId, woundId, observationId } = parse(
        WoundObservationParamsSchema,
        request.params,
      );
      const body = parse(CorrectWoundObservationSchema, request.body);
      return reply
        .code(201)
        .send(
          await service.correctObservation(
            actor,
            patientId,
            woundId,
            observationId,
            ifMatchVersionOf(request),
            body,
          ),
        );
    },
  );

  // Close the wound: healed, or resolved for another reason (one-way).
  app.post(
    "/api/v1/patients/:patientId/wounds/:woundId/resolve",
    { preHandler: [NO_AI, AUTHOR, SCOPE_FOR("assessment.author")] },
    async (request) => {
      const actor = writeActor(request);
      const { patientId, woundId } = parse(WoundParamsSchema, request.params);
      const body = parse(ResolveWoundSchema, request.body);
      return service.resolveWound(actor, patientId, woundId, body);
    },
  );
}
