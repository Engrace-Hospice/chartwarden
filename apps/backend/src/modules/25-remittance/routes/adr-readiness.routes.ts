// apps/backend/src/modules/25-remittance/routes/adr-readiness.routes.ts - M25 milestone 8a-1 routes: ADVISORY ADR
// documentation readiness. Reads gate on `adr.readiness_read`, a review request on `adr.readiness_request`, a finding
// disposition on `adr.readiness_dispose`. Nothing here is If-Match: a readiness review never moves the case version, and
// nothing it says gates sign-off or filing. Every mutation requires an Idempotency-Key. Org, actor and provider-entity
// scope are server-derived (actor.ts).
import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { ADR_CHECKLIST_KEYS, READINESS_DISPOSITIONS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import type { AdrReadinessService } from "./adr-readiness-service";
import { requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import { parse } from "./m25-typebox";

export interface AdrReadinessRouteDeps {
  readonly adrReadinessService: AdrReadinessService;
}

const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const CHECKLIST_KEY = Type.Union(ADR_CHECKLIST_KEYS.map((k) => Type.Literal(k)));
const DISPOSITION = Type.Union(READINESS_DISPOSITIONS.map((d) => Type.Literal(d)));

export const AdrReadinessDispositionRequestSchema = Type.Object({ disposition: DISPOSITION });

const FindingViewSchema = Type.Object({
  id: Type.String(),
  checklistKey: Type.String(),
  status: Type.String(),
  citedDocumentIds: Type.Array(Type.String()),
  note: Type.String(),
  disposition: NULLABLE_STRING,
  disposedAt: NULLABLE_STRING,
});

const KeyGapSchema = Type.Object({
  checklistKey: CHECKLIST_KEY,
  status: Type.Union([
    Type.Literal("documents_attached"),
    Type.Literal("no_document_attached"),
    Type.Literal("marked_not_applicable"),
  ]),
  documentIds: Type.Array(Type.String()),
  isGap: Type.Boolean(),
});

export const AdrReadinessViewSchema = Type.Object({
  adrCaseId: Type.String(),
  caseState: Type.String(),
  caseVersion: Type.Integer(),
  generatedAt: Type.String(),
  gaps: Type.Object({
    keys: Type.Array(KeyGapSchema),
    unmappedDocumentIds: Type.Array(Type.String()),
  }),
  review: Type.Union([
    Type.Object({
      id: Type.String(),
      status: Type.String(),
      source: Type.String(),
      requestedAt: Type.String(),
      requestedByMembershipId: Type.String(),
      stale: Type.Boolean(),
      unavailableReason: NULLABLE_STRING,
      droppedFindingCount: Type.Integer(),
      modelVersionPin: NULLABLE_STRING,
      promptTemplateVersion: NULLABLE_STRING,
      allDisposed: Type.Boolean(),
      findings: Type.Array(FindingViewSchema),
    }),
    Type.Null(),
  ]),
});

export const AdrReadinessRequestResultSchema = Type.Object({
  reviewId: Type.String(),
  status: Type.String(),
  source: Type.String(),
  findingCount: Type.Integer(),
});

export const AdrReadinessDispositionResultSchema = Type.Object({
  id: Type.String(),
  disposition: Type.String(),
});

const READ = P("adr.readiness_read");
const REQUEST = P("adr.readiness_request");
const DISPOSE = P("adr.readiness_dispose");
const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const uuidParam = (request: { params?: unknown }, name: string, what: string): string => {
  const value = (request.params as Record<string, string>)[name];
  if (typeof value !== "string" || !UUID.test(value)) throw new NotFoundError(what);
  return value;
};

export function registerAdrReadinessRoutes(
  app: FastifyInstance,
  deps: AdrReadinessRouteDeps,
): void {
  const { adrReadinessService } = deps;

  app.get(
    "/api/v1/adrs/:id/readiness",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "adr_readiness", resourceIdParam: "id" } },
    },
    async (request, reply) =>
      reply.send(
        await adrReadinessService.getAdrReadiness(
          actorOf(request),
          uuidParam(request, "id", "ADR case"),
        ),
      ),
  );

  app.post(
    "/api/v1/adrs/:id/readiness/reviews",
    { preHandler: [REQUEST, IDEMPOTENT] },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await adrReadinessService.requestAdrReadiness(
            writeActorOf(request),
            uuidParam(request, "id", "ADR case"),
          ),
        ),
  );

  app.post(
    "/api/v1/adrs/:id/readiness/findings/:findingId/disposition",
    { preHandler: [DISPOSE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AdrReadinessDispositionRequestSchema, request.body);
      return reply.send(
        await adrReadinessService.disposeReadinessFinding(
          writeActorOf(request),
          uuidParam(request, "id", "ADR case"),
          uuidParam(request, "findingId", "readiness finding"),
          body.disposition,
        ),
      );
    },
  );
}
