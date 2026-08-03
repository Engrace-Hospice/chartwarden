// apps/backend/src/modules/35-subscription/routes/admin.routes.ts — M35 (§4.2 platform-ops surface,
// `/api/admin`). The platform-billing plan / subscription / dunning / refund / promo / revenue / usage /
// stripe routes. Reads gate on the §4.7 `*.admin.read` / `*.read` keys + `platform_billing_scope` (§4.8);
// the mutating routes add the §D14 `requireStepUp` assertion + the §4.17 `Idempotency-Key` guard, and the
// refund approve/deny routes compose `refund_requires_step_up_approval` (§4.8; the four-eyes clause is
// re-asserted by the service against the loaded refund row). Org/actor/membership binding is ALWAYS
// server-side (`request.context`), NEVER read off the body; the cross-tenant reads/writes run under the
// injected platform runner (M1 `withPlatformContext`), never a tenant RLS scope.
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import { IDEMPOTENT, P, PLATFORM_SCOPE, REFUND_APPROVAL, STEP_UP } from "./guards";
import type { M35RouteService } from "./service";
import {
  AddMeterBodySchema,
  AdminSubscriptionListQuerySchema,
  ApplyPromoBodySchema,
  CreatePlanBodySchema,
  CreatePromoBodySchema,
  DenyRefundBodySchema,
  DunningListQuerySchema,
  IdParamsSchema,
  ListQuerySchema,
  OrgUsageParamsSchema,
  PauseSubscriptionBodySchema,
  PlanMeterParamsSchema,
  RequestRefundBodySchema,
  RevokePromoBodySchema,
  StripeEventParamsSchema,
  SubIdParamsSchema,
  UpdateMeterBodySchema,
  UpdatePlanBodySchema,
  UpdatePromoBodySchema,
  parse,
} from "./subscription-typebox";

export interface AdminRouteDeps {
  readonly service: M35RouteService;
}

/** Register the §4.2 platform-ops subscription-billing routes. */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { service } = deps;

  // ── plans ──
  app.get("/api/admin/plans", { preHandler: [P("plan.admin.read"), PLATFORM_SCOPE("plan.admin.read")] }, async () =>
    service.adminListPlans(),
  );
  app.get(
    "/api/admin/plans/:id",
    { preHandler: [P("plan.admin.read"), PLATFORM_SCOPE("plan.admin.read")] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminGetPlan(id);
    },
  );
  app.post(
    "/api/admin/plans",
    { preHandler: [P("plan.admin.write"), PLATFORM_SCOPE("plan.admin.write"), STEP_UP("plan.admin.write"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreatePlanBodySchema, request.body);
      return reply.code(201).send(await service.adminCreatePlan(actor, body));
    },
  );
  app.patch(
    "/api/admin/plans/:id",
    { preHandler: [P("plan.admin.write"), PLATFORM_SCOPE("plan.admin.write"), STEP_UP("plan.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminUpdatePlan(actor, id, parse(UpdatePlanBodySchema, request.body));
    },
  );
  app.post(
    "/api/admin/plans/:id/activate",
    { preHandler: [P("plan.admin.write"), PLATFORM_SCOPE("plan.admin.write"), STEP_UP("plan.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminActivatePlan(actor, id);
    },
  );
  app.post(
    "/api/admin/plans/:id/deprecate",
    { preHandler: [P("plan.admin.write"), PLATFORM_SCOPE("plan.admin.write"), STEP_UP("plan.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminDeprecatePlan(actor, id);
    },
  );
  app.post(
    "/api/admin/plans/:id/meters",
    { preHandler: [P("plan.admin.write"), PLATFORM_SCOPE("plan.admin.write"), STEP_UP("plan.admin.write"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return reply.code(201).send(await service.adminAddMeter(actor, id, parse(AddMeterBodySchema, request.body)));
    },
  );
  app.patch(
    "/api/admin/plans/:id/meters/:meterId",
    { preHandler: [P("plan.admin.write"), PLATFORM_SCOPE("plan.admin.write"), STEP_UP("plan.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id, meterId } = parse(PlanMeterParamsSchema, request.params);
      return service.adminUpdateMeter(actor, id, meterId, parse(UpdateMeterBodySchema, request.body));
    },
  );

  // ── subscriptions ──
  app.get(
    "/api/admin/subscriptions",
    { preHandler: [P("subscription.admin.read"), PLATFORM_SCOPE("subscription.admin.read")] },
    async (request) => {
      const q = parse(AdminSubscriptionListQuerySchema, request.query);
      return service.adminListSubscriptions({ status: q.status, organizationId: q.organizationId }, q.cursor, q.limit);
    },
  );
  app.get(
    "/api/admin/subscriptions/:id",
    { preHandler: [P("subscription.admin.read"), PLATFORM_SCOPE("subscription.admin.read")] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminGetSubscription(id);
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/pause",
    { preHandler: [P("subscription.admin.write"), PLATFORM_SCOPE("subscription.admin.write"), STEP_UP("subscription.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(PauseSubscriptionBodySchema, request.body);
      return service.adminPauseSubscription(actor, id, body.pausedUntil ?? null);
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/resume",
    { preHandler: [P("subscription.admin.write"), PLATFORM_SCOPE("subscription.admin.write"), STEP_UP("subscription.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminResumeSubscription(actor, id);
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/cancel",
    { preHandler: [P("subscription.admin.write"), PLATFORM_SCOPE("subscription.admin.write"), STEP_UP("subscription.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminCancelSubscription(actor, id);
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/apply_promo",
    { preHandler: [P("promo.admin.apply"), PLATFORM_SCOPE("promo.admin.apply"), STEP_UP("promo.admin.apply"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(ApplyPromoBodySchema, request.body);
      return service.adminApplyPromo(actor, id, body.promoCode);
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/revoke_promo",
    { preHandler: [P("promo.admin.revoke"), PLATFORM_SCOPE("promo.admin.revoke"), STEP_UP("promo.admin.revoke"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(RevokePromoBodySchema, request.body);
      return service.adminRevokePromo(actor, id, body.applicationId);
    },
  );

  // ── dunning ──
  app.get(
    "/api/admin/dunning",
    { preHandler: [P("dunning.admin.read"), PLATFORM_SCOPE("dunning.admin.read")] },
    async (request) => {
      const q = parse(DunningListQuerySchema, request.query);
      return service.adminListDunning({ stage: q.stage }, q.cursor, q.limit);
    },
  );
  app.post(
    "/api/admin/dunning/:subscriptionId/skip_stage",
    { preHandler: [P("dunning.admin.override"), PLATFORM_SCOPE("dunning.admin.override"), STEP_UP("dunning.admin.override"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { subscriptionId } = parse(SubIdParamsSchema, request.params);
      return service.adminSkipDunningStage(actor, subscriptionId);
    },
  );
  app.post(
    "/api/admin/dunning/:subscriptionId/reset",
    { preHandler: [P("dunning.admin.override"), PLATFORM_SCOPE("dunning.admin.override"), STEP_UP("dunning.admin.override"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { subscriptionId } = parse(SubIdParamsSchema, request.params);
      return service.adminResetDunning(actor, subscriptionId);
    },
  );

  // ── refunds ──
  app.post(
    "/api/admin/refunds",
    { preHandler: [P("refund.request"), PLATFORM_SCOPE("refund.request"), STEP_UP("refund.request"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(RequestRefundBodySchema, request.body);
      return reply.code(201).send(await service.requestRefund(actor, body));
    },
  );
  app.post(
    "/api/admin/refunds/:id/approve",
    { preHandler: [P("refund.approve"), REFUND_APPROVAL("refund.approve"), STEP_UP("refund.approve"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.approveRefund(actor, id);
    },
  );
  app.post(
    "/api/admin/refunds/:id/deny",
    { preHandler: [P("refund.approve"), REFUND_APPROVAL("refund.approve"), STEP_UP("refund.approve"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(DenyRefundBodySchema, request.body);
      return service.denyRefund(actor, id, body.reason);
    },
  );
  app.get("/api/admin/refunds", { preHandler: [P("refund.read"), PLATFORM_SCOPE("refund.read")] }, async (request) => {
    const q = parse(ListQuerySchema, request.query);
    return service.listRefunds(q.cursor, q.limit);
  });
  app.get(
    "/api/admin/refunds/:id",
    { preHandler: [P("refund.read"), PLATFORM_SCOPE("refund.read")] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminGetRefund(id);
    },
  );

  // ── promos ──
  app.get("/api/admin/promos", { preHandler: [P("promo.admin.read"), PLATFORM_SCOPE("promo.admin.read")] }, async () =>
    service.adminListPromos(),
  );
  app.get(
    "/api/admin/promos/:id",
    { preHandler: [P("promo.admin.read"), PLATFORM_SCOPE("promo.admin.read")] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminGetPromo(id);
    },
  );
  app.post(
    "/api/admin/promos",
    { preHandler: [P("promo.admin.write"), PLATFORM_SCOPE("promo.admin.write"), STEP_UP("promo.admin.write"), IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreatePromoBodySchema, request.body);
      return reply.code(201).send(await service.adminCreatePromo(actor, body));
    },
  );
  app.patch(
    "/api/admin/promos/:id",
    { preHandler: [P("promo.admin.write"), PLATFORM_SCOPE("promo.admin.write"), STEP_UP("promo.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminUpdatePromo(actor, id, parse(UpdatePromoBodySchema, request.body));
    },
  );
  app.post(
    "/api/admin/promos/:id/deactivate",
    { preHandler: [P("promo.admin.write"), PLATFORM_SCOPE("promo.admin.write"), STEP_UP("promo.admin.write"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.adminDeactivatePromo(actor, id);
    },
  );

  // ── revenue ──
  app.get(
    "/api/admin/revenue/snapshots",
    { preHandler: [P("revenue.admin.read"), PLATFORM_SCOPE("revenue.admin.read")] },
    async (request) => {
      const q = parse(ListQuerySchema, request.query);
      return service.listRevenueSnapshots(q.cursor, q.limit);
    },
  );
  app.get(
    "/api/admin/revenue/current",
    { preHandler: [P("revenue.admin.read"), PLATFORM_SCOPE("revenue.admin.read")] },
    async () => service.getCurrentRevenue(),
  );
  app.post(
    "/api/admin/revenue/snapshots/compute",
    { preHandler: [P("revenue.admin.write"), PLATFORM_SCOPE("revenue.admin.write"), STEP_UP("revenue.admin.write"), IDEMPOTENT] },
    async (request) => service.recomputeRevenue(writeActorOf(request)),
  );

  // ── usage + stripe ──
  app.get(
    "/api/admin/usage/:organizationId/current",
    { preHandler: [P("usage.admin.read"), PLATFORM_SCOPE("usage.admin.read")] },
    async (request) => {
      const { organizationId } = parse(OrgUsageParamsSchema, request.params);
      return service.adminGetTenantUsage(organizationId);
    },
  );
  app.get(
    "/api/admin/webhooks/stripe/recent",
    { preHandler: [P("stripe.admin.read"), PLATFORM_SCOPE("stripe.admin.read")] },
    async (request) => {
      const q = parse(ListQuerySchema, request.query);
      return service.listRecentWebhooks(q.cursor, q.limit);
    },
  );
  app.post(
    "/api/admin/webhooks/stripe/replay/:eventId",
    { preHandler: [P("stripe.admin.replay"), PLATFORM_SCOPE("stripe.admin.replay"), STEP_UP("stripe.admin.replay"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const { eventId } = parse(StripeEventParamsSchema, request.params);
      return service.replayWebhook(actor, eventId);
    },
  );
}
