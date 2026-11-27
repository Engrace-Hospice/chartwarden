import { requireAbac, requirePermission } from "@chartwarden/auth";
import {
  type PreHandler,
  membershipActorOf,
  parse,
  rejectAiActor,
} from "@chartwarden/shared/route-kit";
import { UnauthorizedError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InHomeRespiteService } from "../in-home-respite";

export const InHomeRespiteEncounterParamsSchema = Type.Object({
  encounterId: Type.String({ format: "uuid" }),
});
export const InHomeRespiteCorrectionBodySchema = Type.Object(
  {
    serviceId: Type.String({ format: "uuid" }),
    expectedVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const InHomeRespiteEvidenceViewSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    serviceId: Type.String({ format: "uuid" }),
    version: Type.Integer({ minimum: 1 }),
    sourceEncounterId: Type.String({ format: "uuid" }),
    sourceEncounterVersion: Type.Integer({ minimum: 1 }),
    serviceDate: Type.String({ format: "date" }),
    serviceStartedAt: Type.String({ format: "date-time" }),
    serviceEndedAt: Type.String({ format: "date-time" }),
    observedDurationSeconds: Type.Integer({ minimum: 1 }),
    timeSource: Type.Union([Type.Literal("evv"), Type.Literal("clinician")]),
    supersedesId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    recordedByMembershipId: Type.String({ format: "uuid" }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export const InHomeRespiteEvidenceListSchema = Type.Array(InHomeRespiteEvidenceViewSchema);
const READ = requirePermission("encounter.read") as PreHandler;
const AUTHOR = requirePermission("encounter.author") as PreHandler;
const SCOPE = (action: string) =>
  requireAbac(action, "encounter.scope", { notFoundOnDeny: true }) as PreHandler;
const AUTHOR_OR_SUPERVISOR = requireAbac(
  "encounter.author",
  "is_author_or_supervisor",
) as PreHandler;
const NO_AI = rejectAiActor(
  "AI principals cannot attest or correct delivered in-home respite evidence",
) as PreHandler;
const encounterId = (request: FastifyRequest) =>
  parse(InHomeRespiteEncounterParamsSchema, request.params).encounterId;
const userId = (request: FastifyRequest): string => {
  const id = request.context?.userId;
  if (typeof id !== "string" || id.length === 0) throw new UnauthorizedError();
  return id;
};

export function registerInHomeRespiteRoutes(
  app: FastifyInstance,
  deps: { readonly service: InHomeRespiteService },
): void {
  const readGuards = [READ, SCOPE("encounter.read")];
  const writeGuards = [NO_AI, AUTHOR, SCOPE("encounter.author"), AUTHOR_OR_SUPERVISOR];

  app.get(
    "/api/v1/encounters/:encounterId/in-home-respite",
    {
      preHandler: readGuards,
      config: {
        auditRead: {
          resourceKind: "encounter_in_home_respite_evidence",
          resourceIdParam: "encounterId",
          fields: ["serviceDate", "serviceStartedAt", "serviceEndedAt", "observedDurationSeconds"],
        },
      },
    },
    async (request) => {
      const actor = membershipActorOf(request);
      return deps.service.readForSignedEncounter(
        actor.organizationId,
        userId(request),
        encounterId(request),
      );
    },
  );

  app.post(
    "/api/v1/encounters/:encounterId/in-home-respite",
    { preHandler: writeGuards },
    async (request, reply) => {
      const actor = membershipActorOf(request);
      const result = await deps.service.recordForSignedEncounter(
        actor.organizationId,
        userId(request),
        actor.userId,
        encounterId(request),
      );
      reply.header("etag", `"${result.version}"`);
      return result;
    },
  );

  app.post(
    "/api/v1/encounters/:encounterId/in-home-respite/corrections",
    { preHandler: writeGuards },
    async (request, reply) => {
      const actor = membershipActorOf(request);
      const body = parse(InHomeRespiteCorrectionBodySchema, request.body);
      const result = await deps.service.correctFromSignedEncounter(
        actor.organizationId,
        userId(request),
        actor.userId,
        { ...body, encounterId: encounterId(request) },
      );
      reply.header("etag", `"${result.version}"`);
      return result;
    },
  );
}
