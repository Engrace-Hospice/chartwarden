// apps/backend/src/modules/08-encounters/routes/draft-section-routes.ts — the visit-note draft and its section resolution (ADR-0114, PR C2b1).
//
//   GET /api/v1/encounters/:encounterId/draft                       the draft for the SESSION viewer, every section with its state   encounter.read
//   PUT /api/v1/encounters/:encounterId/draft/sections/:sectionId   confirm or deselect one section against the content seen          encounter.author
//
// Both answer 404 when the tenant has the draft switched off (the service decides, before it reads anything), and for an encounter that is not
// the caller's tenant. The viewer is the server-assembled session (roles, active membership), never request input: the draft is computed per
// reader so 42 CFR Part 2 redaction holds (VN-D10). The PUT carries the SAME permission and ABAC chain as the selections save
// (`encounter.author`, caseload scope, author-or-supervisor), minus the `If-Match` version (the section's content hash is the optimistic
// lock), plus the AI-principal refusal: an AI may not confirm what it drafted a note from. A stale hash or corpus version is 409
// `DRAFT_SECTION_STALE`; a draft that cannot be computed is 503 `DRAFT_UNAVAILABLE`.
import type { AuditContext } from "@chartwarden/audit";
import { requireAbac, requirePermission } from "@chartwarden/auth";
import {
  type PreHandler,
  actorOf,
  rejectAiActor,
  writeActorOf,
} from "@chartwarden/shared/route-kit";
import type { TObject } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DraftService } from "../drafting/draft-service";
import {
  DraftParamsSchema,
  DraftSectionParamsSchema,
  ResolveSectionSchema,
} from "./draft-section-typebox";
import { parse } from "./encounters-typebox";

export interface DraftSectionRouteDeps {
  readonly service: DraftService;
}

const READ = requirePermission("encounter.read") as PreHandler;
const AUTHOR = requirePermission("encounter.author") as PreHandler;
const NO_AI = rejectAiActor(
  "AI principals cannot confirm or deselect a visit-note section (D13)",
) as PreHandler;
// The same `encounter.scope` caseload guard the selections routes carry; `notFoundOnDeny` keeps a cross-tenant or out-of-caseload denial
// the same answer as an absent encounter.
const SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "encounter.scope", { notFoundOnDeny: true }) as PreHandler;
const IS_AUTHOR_OR_SUPERVISOR = requireAbac(
  "encounter.author",
  "is_author_or_supervisor",
) as PreHandler;
/** A malformed id is a 422 BEFORE the scope predicate casts it to a uuid (that cast would be a 500). */
const PARAMS_VALID = (schema: TObject): PreHandler =>
  (async (request: FastifyRequest) => {
    parse(schema, request.params);
  }) as unknown as PreHandler;

function auditContextOf(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

export function registerDraftSectionRoutes(
  app: FastifyInstance,
  deps: DraftSectionRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/encounters/:encounterId/draft",
    {
      preHandler: [READ, PARAMS_VALID(DraftParamsSchema), SCOPE_FOR("encounter.read")],
      config: {
        // A chart open of the patient's own record: accountable against the patient named in the response (§164.528). Names only.
        auditRead: {
          resourceKind: "encounter_draft",
          resourceIdParam: "encounterId",
          patientIdPayloadPath: "patientId",
          fields: [
            "sections",
            "state",
            "text",
            "contentHash",
            "corpusVersion",
            "part2Derived",
            "origins",
          ],
        },
      },
    },
    async (request) => {
      const { encounterId } = parse(DraftParamsSchema, request.params);
      const actor = actorOf(request);
      return service.getDraft(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: actor.roles,
          membershipId: actor.membershipId,
        },
        encounterId,
      );
    },
  );

  app.put(
    "/api/v1/encounters/:encounterId/draft/sections/:sectionId",
    {
      preHandler: [
        AUTHOR,
        NO_AI,
        PARAMS_VALID(DraftSectionParamsSchema),
        SCOPE_FOR("encounter.author"),
        IS_AUTHOR_OR_SUPERVISOR,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { encounterId, sectionId } = parse(DraftSectionParamsSchema, request.params);
      const body = parse(ResolveSectionSchema, request.body);
      return service.resolveSection(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: actor.roles,
          membershipId: actor.membershipId,
        },
        encounterId,
        sectionId,
        body,
        auditContextOf(request),
      );
    },
  );
}
