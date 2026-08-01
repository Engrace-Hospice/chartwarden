// apps/backend/src/modules/30-quality/routes/mortality.routes.ts — M30 (§4.1 R-70..R-73).
//
// The safety-surveillance MORTALITY-REVIEW plane (every hospice death gets a three-dimension review —
// clinical, satisfaction, compliance — within the ≤30-day target window):
//   R-70 GET   /quality/mortality                       — list reviews (status/patient filter; PHI;
//        cursor-paginated on `(death_at DESC, id)`, §4.1.2).
//   R-71 GET   /quality/mortality/:reviewId             — review detail (the three dimensions).
//   R-72 PATCH /quality/mortality/:reviewId             — update review fields (assignee-owned; version-OCC,
//        no Idempotency-Key).
//   R-73 POST  /quality/mortality/:reviewId/complete    — complete the review (assignee-owned; the package
//        completeness predicate gates all three dimensions). Idempotency-Key (org, reviewId, reviewer).
//
// AUTHORIZATION (the REAL §4.6/§4.7 contract — `requirePermission` + `requireAbac` from @wardenx/auth, M3):
// each route gates on its §4.6 key, then composes the §4.1 ABAC column — the M3-base `inOrg` (reads) plus
// the M30-owned `assignedToMortality` (writes), whose target is `request.params` (the `:reviewId`). These
// are PHI routes: the §4.1 "requirePatientScope()" gate is realized in THIS codebase by the §4.7 predicate
// chain here PLUS the M3 patient-level RLS predicate active inside the service's ONE `withOrgContext` tx
// (P2c) PLUS the row-level `part2Redisclosure` redaction — there is no standalone `requirePatientScope`
// export in @wardenx/auth (the §4.1 note's mechanism, not a symbol). R-73 carries `Idempotency-Key`; the
// PATCH (R-72) is version-OCC-protected and §4.1.1-exempt. Org/actor binding is ALWAYS server-side
// (`request.context` via `actorOf`/`writeActorOf`), NEVER the body. The service drives the pure
// @wardenx/quality mortality machine and emits the §4.10 `m30.mortality.*` events transactionally.
import { requireAbac, requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import type { M30ReadRouteService, MortalityListFilter } from "./read-service";
import type { M30WriteRouteService } from "./write-service";
import {
  CompleteMortalityReviewBodySchema,
  MortalityListQuerySchema,
  ReviewIdParamsSchema,
  UpdateMortalityReviewBodySchema,
  parse,
} from "./quality-typebox";

export interface MortalityRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// §4.7 ABAC composed AFTER RBAC; the default target is `request.params` (the `:reviewId`).
const ABAC = (key: string, predicate: string): PreHandler => requireAbac(key, predicate) as PreHandler;

const MORT_READ = P("mortality.read");
const MORT_WRITE = P("mortality.write");
const MORT_CLOSE = P("mortality.close");

const READ_INORG = ABAC("mortality.read", "inOrg");
const WRITE_INORG = ABAC("mortality.write", "inOrg");
const WRITE_ASSIGNED = ABAC("mortality.write", "assignedToMortality");
const CLOSE_INORG = ABAC("mortality.close", "inOrg");
const CLOSE_ASSIGNED = ABAC("mortality.close", "assignedToMortality");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 mortality routes (R-70..R-73). */
export function registerMortalityRoutes(app: FastifyInstance, deps: MortalityRouteDeps): void {
  const { readService, writeService } = deps;

  // R-70 — list mortality reviews (cursor-paginated; PHI). §4.1/§4.1.2.
  app.get(
    "/api/v1/quality/mortality",
    { preHandler: [MORT_READ, READ_INORG], config: { auditRead: { resourceKind: "mortality_review", list: true } } },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(MortalityListQuerySchema, request.query);
      const filter: MortalityListFilter = { status: q.status, patientId: q.patientId };
      return readService.listMortalityReviews(actor, filter, q.cursor, q.limit);
    },
  );

  // R-71 — review detail (the three review dimensions). §4.1.
  app.get(
    "/api/v1/quality/mortality/:reviewId",
    { preHandler: [MORT_READ, READ_INORG], config: { auditRead: { resourceKind: "mortality_review", resourceIdParam: "reviewId" } } },
    async (request) => {
      const actor = actorOf(request);
      const { reviewId } = parse(ReviewIdParamsSchema, request.params);
      return readService.getMortalityReview(actor, reviewId);
    },
  );

  // R-72 — update review fields (assignee-owned; version-OCC; §4.1.1-exempt PATCH). §4.1.
  app.patch(
    "/api/v1/quality/mortality/:reviewId",
    { preHandler: [MORT_WRITE, WRITE_INORG, WRITE_ASSIGNED] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { reviewId } = parse(ReviewIdParamsSchema, request.params);
      const body = parse(UpdateMortalityReviewBodySchema, request.body);
      const res = await writeService.updateMortalityReview(actor, reviewId, {
        dimensions: body.dimensions,
        assignedToMembershipId: body.assignedToMembershipId,
      });
      return reply.code(200).send(res);
    },
  );

  // R-73 — complete the review (all three dimensions present; assignee-owned). Idempotency-Key
  // (org, reviewId, reviewer). §4.1/§4.1.1.
  app.post(
    "/api/v1/quality/mortality/:reviewId/complete",
    { preHandler: [MORT_CLOSE, CLOSE_INORG, CLOSE_ASSIGNED, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { reviewId } = parse(ReviewIdParamsSchema, request.params);
      const body = parse(CompleteMortalityReviewBodySchema, request.body);
      const res = await writeService.completeMortalityReview(actor, reviewId, {
        dimensions: body.dimensions,
      });
      return reply.code(200).send(res);
    },
  );
}
