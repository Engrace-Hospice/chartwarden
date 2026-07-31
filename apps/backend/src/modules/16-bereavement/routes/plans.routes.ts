// apps/backend/src/modules/16-bereavement/routes/plans.routes.ts — M16 (§4.1) routes 1–10, 27–29, 33:
// the bereavement-plan read surface, the assignment + activation ladder, the pause/resume/close lifecycle,
// the schedule regeneration, the risk recompute + history, and the D18-gated counselor first contact.
//
// Every route gates on its §4.7 `requirePermission` key plus the §4.8 ABAC binding the §4.1 table names;
// the two close routes add the "step_up_fresh" gate; every mutation declares `Idempotency-Key` (ADR-0021)
// and every state transition requires `If-Match` (§2.5 — a blind write is refused, not last-write-wins).
// Every PHI GET declares its M4 read audit (§8.1 `m16.bereavement.read.aggregate` / `.read.list`).
//
// Routes 3, 4 and 5 bind `org_scope_bereavement_oversight`, NOT `bereavement_window`: at those three
// moments the plan is `eligible` or `initiating`, and §4.8 pins the window predicate to {active, paused}.
// See `./guards.ts` for the full reasoning — it is the difference between a working assignment flow and a
// permanent 403.
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import {
  ABAC_DISCIPLINE_COUNSELOR,
  ABAC_OVERSIGHT,
  ABAC_VOLUNTEER_GATES,
  ABAC_WINDOW_PLAN,
  P,
  STEP_UP,
} from "./guards";
import {
  AssignCounselorBody,
  AssignVolunteerBody,
  CloseEarlyBody,
  CosignCloseBody,
  InitiateContactBody,
  OutreachListQuerySchema,
  PausePlanBody,
  PlanListQuerySchema,
  PlanParams,
  RecomputeRiskBody,
  RegenerateScheduleBody,
  ResumePlanBody,
  RiskScoreListQuerySchema,
  SeedRosterAndScheduleBody,
  parse,
  parseQuery,
} from "./m16-typebox";
import type { M16ReadService } from "./read-service";
import type { M16WriteService } from "./write-service";

export interface PlanRouteDeps {
  readonly readService: M16ReadService;
  readonly writeService: M16WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** The M4 read-audit declaration every PHI plan read carries (§8.1 / M4 §2.5). */
const PLAN_READ = { resourceKind: "bereavement_plan", resourceIdParam: "planId" } as const;

export function registerBereavementPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): void {
  const { readService, writeService } = deps;

  // 1 — plan worklist (counselor caseload by default; cursor-paginated).
  app.get(
    "/api/v1/bereavement/plans",
    {
      preHandler: [P("bereavement.plan.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "bereavement_plan", list: true } },
    },
    async (request) =>
      readService.listPlans(actorOf(request), parseQuery(PlanListQuerySchema, request.query)),
  );

  // 2 — plan detail with the rolled-up roster + risk (§7.13 categories ride `redacted_categories`).
  app.get(
    "/api/v1/bereavement/plans/:planId",
    {
      preHandler: [P("bereavement.plan.read"), ABAC_WINDOW_PLAN("bereavement.plan.read")],
      config: { auditRead: PLAN_READ },
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const plan = await readService.getPlan(actorOf(request), planId);
      // Out of reach is indistinguishable from absent — the 404 never reveals that a patient died.
      if (!plan) throw new NotFoundError("bereavement plan not found");
      return plan;
    },
  );

  // 3 — initial counselor assignment (`eligible → initiating`).
  app.post(
    "/api/v1/bereavement/plans/:planId/assign-counselor",
    {
      preHandler: [
        P("bereavement.plan.assign_counselor"),
        ABAC_OVERSIGHT("bereavement.plan.assign_counselor"),
        ABAC_DISCIPLINE_COUNSELOR("bereavement.plan.assign_counselor"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(AssignCounselorBody, request.body);
      return writeService.assignCounselor(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 4 — volunteer assignment (the 418.78 gates are the volunteer branch of the discipline predicate).
  app.post(
    "/api/v1/bereavement/plans/:planId/assign-volunteer",
    {
      preHandler: [
        P("bereavement.plan.assign_volunteer"),
        ABAC_OVERSIGHT("bereavement.plan.assign_volunteer"),
        ABAC_VOLUNTEER_GATES("bereavement.plan.assign_volunteer"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(AssignVolunteerBody, request.body);
      return writeService.assignVolunteer(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 5 — seed the roster + materialize the D4 schedule (`initiating → active`). See the header for why the
  //     oversight predicate is bound here rather than §4.1's `bereavement_window` cell.
  app.post(
    "/api/v1/bereavement/plans/:planId/seed-roster-and-schedule",
    {
      preHandler: [
        P("bereavement.plan.activate"),
        ABAC_OVERSIGHT("bereavement.plan.activate"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(SeedRosterAndScheduleBody, request.body);
      return writeService.seedRosterAndSchedule(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 6 — pause (cancels future-dated outreach; a reason is mandatory).
  app.post(
    "/api/v1/bereavement/plans/:planId/pause",
    {
      preHandler: [P("bereavement.plan.pause"), ABAC_WINDOW_PLAN("bereavement.plan.pause"), IDEMPOTENT],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(PausePlanBody, request.body);
      return writeService.pausePlan(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
    },
  );

  // 7 — resume (regenerates the schedule FROM NOW; a touchpoint whose due date passed during the pause is
  //     gone rather than resurrected as a backdated obligation).
  app.post(
    "/api/v1/bereavement/plans/:planId/resume",
    {
      preHandler: [
        P("bereavement.plan.resume"),
        ABAC_WINDOW_PLAN("bereavement.plan.resume"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      parse(ResumePlanBody, request.body);
      return writeService.resumePlan(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request, true),
      });
    },
  );

  // 8 — D7 early close (step-up; ≥40-char narrative). The closure row lands awaiting the route-9 cosign.
  app.post(
    "/api/v1/bereavement/plans/:planId/close-early",
    {
      preHandler: [
        P("bereavement.plan.close_early"),
        ABAC_WINDOW_PLAN("bereavement.plan.close_early"),
        STEP_UP("bereavement.plan.close_early"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CloseEarlyBody, request.body);
      const closure = await writeService.closeEarly(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request, true),
        ...body,
      });
      return reply.code(201).send(closure);
    },
  );

  // 9 — the clinical-supervisor cosign that ratifies the early close (step-up; oversight, not window —
  //     by this point the plan is already `closed_early`).
  app.post(
    "/api/v1/bereavement/plans/:planId/cosign-close",
    {
      preHandler: [
        P("bereavement.plan.close_cosign"),
        ABAC_OVERSIGHT("bereavement.plan.close_cosign"),
        STEP_UP("bereavement.plan.close_cosign"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(CosignCloseBody, request.body);
      return writeService.cosignClose(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 10 — the §3.3.7 closure record (§7.15 survey reconstruction). A closed plan is OUTSIDE the window, so
  //      the window predicate cannot gate this one; oversight or the plan's own counselor reads it, which
  //      the read service resolves from the plan's assignment rather than a predicate.
  app.get(
    "/api/v1/bereavement/plans/:planId/closure",
    { preHandler: [P("bereavement.plan.read")], config: { auditRead: PLAN_READ } },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const closure = await readService.getClosure(actorOf(request), planId);
      if (!closure) throw new NotFoundError("bereavement plan closure not found");
      return closure;
    },
  );

  // 19 — the plan's touchpoints (scheduled + historical), cursor-paginated. Lives with the plan routes
  //      because it is plan-scoped; the per-touchpoint transitions are in `./outreach.routes.ts`.
  app.get(
    "/api/v1/bereavement/plans/:planId/outreach",
    {
      preHandler: [P("bereavement.outreach.read"), ABAC_WINDOW_PLAN("bereavement.outreach.read"), NO_OFFSET],
      config: { auditRead: PLAN_READ },
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const page = await readService.listOutreach(
        actorOf(request),
        planId,
        parseQuery(OutreachListQuerySchema, request.query),
      );
      if (!page) throw new NotFoundError("bereavement plan not found");
      return page;
    },
  );

  // 27 — regenerate the FORWARD outreach book (whole plan, or one contact).
  app.post(
    "/api/v1/bereavement/plans/:planId/regenerate-schedule",
    {
      preHandler: [
        P("bereavement.plan.regenerate_schedule"),
        ABAC_WINDOW_PLAN("bereavement.plan.regenerate_schedule"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(RegenerateScheduleBody, request.body);
      return writeService.regenerateSchedule(writeActorOf(request), planId, {
        expectedVersion: ifMatchVersion(request),
        ...body,
      });
    },
  );

  // 28 — recompute the deterministic D3/D17 score (and, when requested AND `ai.full` is on, the Layer-2
  //      narrative). ALWAYS an append: the §3.3.3 table refuses UPDATE outright.
  app.post(
    "/api/v1/bereavement/plans/:planId/recompute-risk",
    {
      preHandler: [
        P("bereavement.risk.recompute"),
        ABAC_WINDOW_PLAN("bereavement.risk.recompute"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(RecomputeRiskBody, request.body);
      const score = await writeService.recomputeRisk(writeActorOf(request), planId, body);
      return reply.code(201).send(score);
    },
  );

  // 29 — the append-only score ledger (per-contact + plan-level), newest first.
  app.get(
    "/api/v1/bereavement/plans/:planId/risk-scores",
    {
      preHandler: [P("bereavement.risk.read"), ABAC_WINDOW_PLAN("bereavement.risk.read"), NO_OFFSET],
      config: { auditRead: PLAN_READ },
    },
    async (request) => {
      const { planId } = parse(PlanParams, request.params);
      const page = await readService.listRiskScores(
        actorOf(request),
        planId,
        parseQuery(RiskScoreListQuerySchema, request.query),
      );
      if (!page) throw new NotFoundError("bereavement plan not found");
      return page;
    },
  );

  // 33 — the counselor's FIRST contact (§4.3.2 / D18). The external-source cosign gate is enforced in the
  //      service, not as a route guard: its refusal is a 409 carrying the exact machine-readable reason
  //      (`external_source_cosign_pending` / the two tenant-tightened codes) that the UI renders and §8.1
  //      audits as `m16.first_contact.gate_refused`. A 403 from a guard would erase which gate refused.
  app.post(
    "/api/v1/bereavement/plans/:planId/initiate-contact",
    {
      preHandler: [
        P("bereavement.outreach.start"),
        P("bereavement.plan.initiate_contact"),
        ABAC_WINDOW_PLAN("bereavement.plan.initiate_contact"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const { planId } = parse(PlanParams, request.params);
      const body = parse(InitiateContactBody, request.body);
      const outreach = await writeService.initiateContact(writeActorOf(request), planId, body);
      return reply.code(201).send(outreach);
    },
  );
}
