// apps/backend/src/modules/30-quality/routes/cop.routes.ts — M30 (§4.1 R-80..R-82).
//
// The Conditions-of-Participation self-assessment surface: the 23 CoP citation rows with their current
// self-assessed status (`compliant | at_risk | deficient`), the evidence pointers behind each, and the
// 6-month review attestation. Every route is gated by the REAL Authorization Contract
// (`requirePermission` from @wardenx/auth, M3) on the §4.6 `cop.*` keys, both of which carry `abac:"inOrg"`
// in the catalog — so `requirePermission` is the authoritative gate and the org RLS predicate (the
// `withOrgContext` tx) is the scoping. CoP rows are org-scoped compliance posture — NO PHI — so no
// `requirePatientScope` layer applies.
//
// MUTATIONS run through the injected write service → ONE `withOrgContext` tx on the PRIMARY (RLS scopes
// every statement to `app.org_id`); each carries `requireIdempotencyKey` (presence guard; the M1
// `applyIdempotency` middleware does the 24h replay caching). The R-80 read discloses the org's own
// citation rows cursor-paginated per §4.1.2. Org/actor binding is ALWAYS server-side (`request.context`,
// never the body). Mirrors M33 routes/definitions.routes.ts.
import { requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  CitationIdParamsSchema,
  CopCitationListQuerySchema,
  ReviewCopCitationBodySchema,
  UpdateCopCitationBodySchema,
  parse,
} from "./quality-typebox";
import type { M30ReadRouteService } from "./read-service";
import type { M30WriteRouteService } from "./write-service";

export interface CopRouteDeps {
  /** The combined M30 route service (read + write); the P2c Drizzle backend implements both interfaces. */
  readonly service: M30ReadRouteService & M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const COP_READ = P("cop.read");
const COP_WRITE = P("cop.write");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 CoP-compliance routes (R-80..R-82). */
export function registerCopRoutes(app: FastifyInstance, deps: CopRouteDeps): void {
  const { service } = deps;

  // R-80 — list the 23 CoP citation rows with current status (cursor-paginated). §4.1.
  app.get("/api/v1/quality/cop/citations", { preHandler: [COP_READ] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(CopCitationListQuerySchema, request.query);
    return service.listCopCitations(actor, q.cursor, q.limit);
  });

  // R-81 — update a citation's status / evidence pointers. §4.1/§4.2.
  app.patch(
    "/api/v1/quality/cop/citations/:citationId",
    { preHandler: [COP_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { citationId } = parse(CitationIdParamsSchema, request.params);
      const body = parse(UpdateCopCitationBodySchema, request.body);
      const res = await service.updateCopCitation(actor, citationId, {
        status: body.status,
        evidencePointers: body.evidencePointers,
      });
      return reply.code(200).send(res);
    },
  );

  // R-82 — record the 6-month review attestation (advances `lastReviewedAt` / `nextReviewDueAt`). §4.1/§4.2.
  app.post(
    "/api/v1/quality/cop/citations/:citationId/review",
    { preHandler: [COP_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { citationId } = parse(CitationIdParamsSchema, request.params);
      const body = parse(ReviewCopCitationBodySchema, request.body);
      const res = await service.reviewCopCitation(actor, citationId, {
        attestation: body.attestation,
      });
      return reply.code(200).send(res);
    },
  );
}
