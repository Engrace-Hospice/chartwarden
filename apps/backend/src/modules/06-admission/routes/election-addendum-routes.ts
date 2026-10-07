// apps/backend/src/modules/06-admission/routes/election-addendum-routes.ts — FY2027 election statement addendum
// routes (42 CFR 418.24(b)(6), (c), (d); CMS-1851-F). Every route hangs off the ADMISSION path, so the existing
// `admission.scope` ABAC predicate scopes it on `:id` with no new resolver; the service binds `:addendumId` to
// that admission (a version of another admission reads as 404).
//
//   GET    /api/v1/admissions/:id/election-addendum                                  current + history + windows
//   POST   /api/v1/admissions/:id/election-addendum                                  draft / refresh / start an update
//   PATCH  /api/v1/admissions/:id/election-addendum/:addendumId                      edit a draft
//   POST   /api/v1/admissions/:id/election-addendum/:addendumId/furnish              furnish in writing (renders the PDF)
//   POST   /api/v1/admissions/:id/election-addendum/:addendumId/signature            record the receipt signature
//   POST   /api/v1/admissions/:id/election-addendum/:addendumId/refusal              record a refusal (reason required)
//   POST   /api/v1/admissions/:id/election-addendum/:addendumId/signature-not-required  death / revocation / discharge
import { requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ElectionAddendumService } from "../election-addendum/service";
import { IdParamsSchema, parse } from "./admission-typebox";
import {
  ElectionAddendumDraftSchema,
  ElectionAddendumFurnishSchema,
  ElectionAddendumOverviewSchema,
  ElectionAddendumParamsSchema,
  ElectionAddendumPatchSchema,
  ElectionAddendumRefusalSchema,
  ElectionAddendumSignatureNotRequiredSchema,
  ElectionAddendumSignatureSchema,
  ElectionAddendumViewSchema,
} from "./election-addendum-typebox";
import { ResourceNotFoundError } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const ADDENDUM_READ = P("election_addendum.read");
const ADDENDUM_WRITE = P("election_addendum.write");
const ADDENDUM_ACK = P("election_addendum.acknowledge");
/** `admission.scope` on the path's admission id (404 on deny — the §2.2 existence non-leak). */
const scope = (action: string): PreHandler =>
  requireAbac(action, "admission.scope", { notFoundOnDeny: true }) as PreHandler;

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

export interface ElectionAddendumRouteDeps {
  readonly service: ElectionAddendumService;
}

export function registerElectionAddendumRoutes(
  app: FastifyInstance,
  deps: ElectionAddendumRouteDeps,
): void {
  const { service } = deps;
  const ids = (request: FastifyRequest) => parse(ElectionAddendumParamsSchema, request.params);

  app.get(
    "/api/v1/admissions/:id/election-addendum",
    {
      preHandler: [ADDENDUM_READ, scope("election_addendum.read")],
      schema: { response: { 200: ElectionAddendumOverviewSchema } },
      config: { auditRead: { resourceKind: "election_addendum", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const ov = await service.overview(organizationId, id);
      if (!ov) throw new ResourceNotFoundError(id);
      return ov;
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-addendum",
    { preHandler: [ADDENDUM_WRITE, scope("election_addendum.write")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(ElectionAddendumDraftSchema, request.body);
      const ov = await service.draft(organizationId, id, userId);
      return reply.code(201).send(ov);
    },
  );

  app.patch(
    "/api/v1/admissions/:id/election-addendum/:addendumId",
    {
      preHandler: [ADDENDUM_WRITE, scope("election_addendum.write")],
      schema: { response: { 200: ElectionAddendumViewSchema } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, addendumId } = ids(request);
      const { ifVersion, ...patch } = parse(ElectionAddendumPatchSchema, request.body);
      return service.updateDraft(organizationId, id, addendumId, ifVersion, patch, userId);
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-addendum/:addendumId/furnish",
    {
      preHandler: [ADDENDUM_WRITE, scope("election_addendum.write")],
      schema: { response: { 200: ElectionAddendumViewSchema } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, addendumId } = ids(request);
      const body = parse(ElectionAddendumFurnishSchema, request.body);
      return service.furnish(
        organizationId,
        id,
        addendumId,
        body.ifVersion,
        { method: body.method, ...(body.furnishedAt ? { furnishedAt: body.furnishedAt } : {}) },
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-addendum/:addendumId/signature",
    {
      preHandler: [ADDENDUM_ACK, scope("election_addendum.acknowledge")],
      schema: { response: { 200: ElectionAddendumViewSchema } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, addendumId } = ids(request);
      const body = parse(ElectionAddendumSignatureSchema, request.body);
      return service.recordSignature(
        organizationId,
        id,
        addendumId,
        body.ifVersion,
        {
          signerKind: body.signerKind,
          representativeName: body.representativeName ?? null,
          representativeRelationship: body.representativeRelationship ?? null,
          ...(body.signedAt ? { signedAt: body.signedAt } : {}),
        },
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-addendum/:addendumId/refusal",
    {
      preHandler: [ADDENDUM_ACK, scope("election_addendum.acknowledge")],
      schema: { response: { 200: ElectionAddendumViewSchema } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, addendumId } = ids(request);
      const body = parse(ElectionAddendumRefusalSchema, request.body);
      return service.recordRefusal(
        organizationId,
        id,
        addendumId,
        body.ifVersion,
        { reason: body.reason },
        userId,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-addendum/:addendumId/signature-not-required",
    {
      preHandler: [ADDENDUM_ACK, scope("election_addendum.acknowledge")],
      schema: { response: { 200: ElectionAddendumViewSchema } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, addendumId } = ids(request);
      const body = parse(ElectionAddendumSignatureNotRequiredSchema, request.body);
      return service.recordSignatureNotRequired(
        organizationId,
        id,
        addendumId,
        body.ifVersion,
        { reason: body.reason, note: body.note ?? null },
        userId,
      );
    },
  );
}
