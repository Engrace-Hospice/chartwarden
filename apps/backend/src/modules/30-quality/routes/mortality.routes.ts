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
// AUTHORIZATION (the REAL §4.6/§4.7 contract — `requirePermission` + `requireAbac` from @chartwarden/auth, M3):
// each route gates on its §4.6 key, then composes the §4.1 ABAC column — the M3-base `inOrg` (reads) plus
// the M30-owned `assignedToMortality` (writes), whose target is `request.params` (the `:reviewId`). These
// are PHI routes: the §4.1 "requirePatientScope()" gate is realized in THIS codebase by the §4.7 predicate
// chain here PLUS the M3 patient-level RLS predicate active inside the service's ONE `withOrgContext` tx
// (P2c) PLUS the row-level `part2Redisclosure` redaction — there is no standalone `requirePatientScope`
// export in @chartwarden/auth (the §4.1 note's mechanism, not a symbol). R-73 carries `Idempotency-Key`; the
// PATCH (R-72) is version-OCC-protected and §4.1.1-exempt. Org/actor binding is ALWAYS server-side
// (`request.context` via `actorOf`/`writeActorOf`), NEVER the body. The service drives the pure
// @chartwarden/quality mortality machine and emits the §4.10 `m30.mortality.*` events transactionally.
import { requireAbac, requirePermission, resolveActorPermissions } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  CompleteMortalityReviewBodySchema,
  MortalityListQuerySchema,
  ReviewIdParamsSchema,
  UpdateMortalityReviewBodySchema,
  parse,
} from "./quality-typebox";
import type {
  M30ReadRouteService,
  MortalityListFilter,
  MortalityReviewSummaryView,
} from "./read-service";
import { type PatientScopeResolver, defaultPatientScopeResolver } from "./scope-resolver";
import type { M30WriteRouteService } from "./write-service";

export interface MortalityRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
  /** GAP-091 — resolves the caller's patient scope from the server session (defaults to the M5 caseload). */
  readonly resolveScope?: PatientScopeResolver;
  /**
   * D19 — M5's org-explicit, batched minimum-necessary display read, injected as a PORT at the composition root
   * (M30 reads no M5 table). Absent ⇒ the reads never carry a patient name.
   */
  readonly patientDisplay?: PatientDisplayPort;
}

/** The M5 `patientDisplayLabelsForOrg` shape (structural — M30 imports no M5 code). */
export interface PatientDisplayPort {
  displayForPatients(
    organizationId: string,
    patientIds: readonly string[],
  ): Promise<
    ReadonlyMap<string, { readonly displayName: string; readonly mrnSuffix: string | null }>
  >;
}

/**
 * D19 — add the patient display name + MRN suffix to mortality rows, ONLY for a caller holding
 * `mortality.read_with_patient`. One batched M5 read per response; an id M5 does not resolve stays id-only.
 */
async function withPatientDisplay<T extends MortalityReviewSummaryView>(
  rows: readonly T[],
  organizationId: string,
  mayViewPatient: boolean,
  port: PatientDisplayPort | undefined,
): Promise<readonly T[]> {
  if (!mayViewPatient || !port || rows.length === 0) return rows;
  const labels = await port.displayForPatients(
    organizationId,
    rows.map((r) => r.patientId),
  );
  return rows.map((row) => {
    const label = labels.get(row.patientId);
    return label
      ? { ...row, patientDisplayName: label.displayName, patientMrnSuffix: label.mrnSuffix }
      : row;
  });
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// §4.7 ABAC composed AFTER RBAC; the default target is `request.params` (the `:reviewId`).
const ABAC = (key: string, predicate: string): PreHandler =>
  requireAbac(key, predicate) as PreHandler;

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
  const { readService, writeService, patientDisplay } = deps;
  const mayViewPatient = async (request: Parameters<typeof actorOf>[0]): Promise<boolean> =>
    patientDisplay !== undefined &&
    (await resolveActorPermissions(request.context)).has("mortality.read_with_patient");
  const scopeOf = deps.resolveScope ?? defaultPatientScopeResolver;

  // R-70 — list mortality reviews (cursor-paginated; PHI). §4.1/§4.1.2.
  app.get(
    "/api/v1/quality/mortality",
    {
      preHandler: [MORT_READ, READ_INORG],
      config: { auditRead: { resourceKind: "mortality_review", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(MortalityListQuerySchema, request.query);
      const filter: MortalityListFilter = { status: q.status, patientId: q.patientId };
      const page = await readService.listMortalityReviews(
        actor,
        filter,
        q.cursor,
        q.limit,
        await scopeOf(actor, "mortality"),
      );
      const items = await withPatientDisplay(
        page.items,
        actor.organizationId,
        await mayViewPatient(request),
        patientDisplay,
      );
      return { ...page, items };
    },
  );

  // R-71 — review detail (the three review dimensions). §4.1.
  app.get(
    "/api/v1/quality/mortality/:reviewId",
    {
      preHandler: [MORT_READ, READ_INORG],
      config: { auditRead: { resourceKind: "mortality_review", resourceIdParam: "reviewId" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { reviewId } = parse(ReviewIdParamsSchema, request.params);
      const review = await readService.getMortalityReview(
        actor,
        reviewId,
        await scopeOf(actor, "mortality"),
      );
      const [enriched] = await withPatientDisplay(
        [review],
        actor.organizationId,
        await mayViewPatient(request),
        patientDisplay,
      );
      return enriched ?? review;
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
