// apps/backend/src/modules/35-subscription/routes/tenant.routes.ts — M35 (§4.1 tenant surface, `/api/v1`).
//
// The agency-facing subscription / payment-method / invoice / usage routes. Reads gate on the §4.7
// `*.read` keys (the `inOrg` default — aggregate financial state, no PHI per §8.5); the mutating routes
// compose `billing_scope_matches_org` (§4.8) + the §D14 `requireStepUp` assertion on the financial actions
// + the §4.17 `Idempotency-Key` presence guard. Org/actor/membership binding is ALWAYS server-side
// (`request.context` via `actorOf`/`writeActorOf`), NEVER read off the body. `GET /api/v1/billing/status`
// sits under the read-audit-governed `/api/v1/billing` prefix, so it carries a justified no-PHI waiver.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { BILLING_SCOPE, IDEMPOTENT, P, STEP_UP } from "./guards";
import type { M35RouteService } from "./service";
import {
  ApplyPromoBodySchema,
  AttachPaymentMethodBodySchema,
  ChangePlanBodySchema,
  CreateSubscriptionBodySchema,
  IdParamsSchema,
  ListQuerySchema,
  parse,
} from "./subscription-typebox";

export interface TenantRouteDeps {
  readonly service: M35RouteService;
}

/** Register the §4.1 tenant subscription-billing routes. */
export function registerTenantRoutes(app: FastifyInstance, deps: TenantRouteDeps): void {
  const { service } = deps;

  // GET /v1/plans — list active plans (marketing / onboarding; no permission key). §4.1.
  app.get("/api/v1/plans", async () => service.listActivePlans());

  // GET /v1/subscription — read current subscription state. §4.1.
  app.get("/api/v1/subscription", { preHandler: [P("subscription.read")] }, async (request) =>
    service.getSubscription(actorOf(request)),
  );

  // POST /v1/subscription — create subscription (one-time; selects plan). §4.1.
  app.post(
    "/api/v1/subscription",
    {
      preHandler: [
        P("subscription.create"),
        BILLING_SCOPE("subscription.create"),
        STEP_UP("subscription.create"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreateSubscriptionBodySchema, request.body);
      const res = await service.createSubscription(actor, body);
      return reply.code(201).send(res);
    },
  );

  // PATCH /v1/subscription — change plan (upgrade/downgrade). §4.1.
  app.patch(
    "/api/v1/subscription",
    {
      preHandler: [
        P("subscription.update"),
        BILLING_SCOPE("subscription.update"),
        STEP_UP("subscription.update"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(ChangePlanBodySchema, request.body);
      return service.changePlan(actor, body);
    },
  );

  // POST /v1/subscription/cancel — cancel at period end. §4.1.
  app.post(
    "/api/v1/subscription/cancel",
    {
      preHandler: [
        P("subscription.cancel"),
        BILLING_SCOPE("subscription.cancel"),
        STEP_UP("subscription.cancel"),
        IDEMPOTENT,
      ],
    },
    async (request) => service.cancelSubscription(writeActorOf(request)),
  );

  // POST /v1/subscription/resume — resume after pause. §4.1.
  app.post(
    "/api/v1/subscription/resume",
    {
      preHandler: [
        P("subscription.update"),
        BILLING_SCOPE("subscription.update"),
        STEP_UP("subscription.update"),
        IDEMPOTENT,
      ],
    },
    async (request) => service.resumeSubscription(writeActorOf(request)),
  );

  // POST /v1/subscription/apply_promo — apply a publicly-visible promo code. §4.1.
  app.post(
    "/api/v1/subscription/apply_promo",
    { preHandler: [P("subscription.update"), BILLING_SCOPE("subscription.update"), IDEMPOTENT] },
    async (request) => {
      const actor = writeActorOf(request);
      const body = parse(ApplyPromoBodySchema, request.body);
      return service.applyPromoTenant(actor, body.promoCode);
    },
  );

  // GET /v1/payment_methods — list the tenant's payment methods. §4.1.
  app.get("/api/v1/payment_methods", { preHandler: [P("payment_method.read")] }, async (request) =>
    service.listPaymentMethods(actorOf(request)),
  );

  // POST /v1/payment_methods/setup_intent — create a Stripe SetupIntent (dispatcher-provisioned). §4.1.
  app.post(
    "/api/v1/payment_methods/setup_intent",
    {
      preHandler: [
        P("payment_method.write"),
        BILLING_SCOPE("payment_method.write"),
        STEP_UP("payment_method.write"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply.code(202).send(await service.createSetupIntent(writeActorOf(request))),
  );

  // POST /v1/payment_methods/attach — attach a SetupIntent-completed pm to the org. §4.1.
  app.post(
    "/api/v1/payment_methods/attach",
    {
      preHandler: [
        P("payment_method.write"),
        BILLING_SCOPE("payment_method.write"),
        STEP_UP("payment_method.write"),
        IDEMPOTENT,
      ],
    },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(AttachPaymentMethodBodySchema, request.body);
      return reply.code(201).send(await service.attachPaymentMethod(actor, body));
    },
  );

  // PATCH /v1/payment_methods/:id/set_default — set as default. §4.1.
  app.patch(
    "/api/v1/payment_methods/:id/set_default",
    {
      preHandler: [
        P("payment_method.write"),
        BILLING_SCOPE("payment_method.write"),
        STEP_UP("payment_method.write"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.setDefaultPaymentMethod(actor, id);
    },
  );

  // DELETE /v1/payment_methods/:id — detach (soft-delete). §4.1.
  app.delete(
    "/api/v1/payment_methods/:id",
    {
      preHandler: [
        P("payment_method.write"),
        BILLING_SCOPE("payment_method.write"),
        STEP_UP("payment_method.write"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.detachPaymentMethod(actor, id);
    },
  );

  // GET /v1/invoices — list the tenant's invoices. §4.1.
  app.get("/api/v1/invoices", { preHandler: [P("invoice.read")] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(ListQuerySchema, request.query);
    return service.listInvoices(actor, q.cursor, q.limit);
  });

  // GET /v1/invoices/:id — read invoice detail. §4.1.
  app.get("/api/v1/invoices/:id", { preHandler: [P("invoice.read")] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.getInvoice(actor, id);
  });

  // GET /v1/invoices/:id/hosted_url — the Stripe-hosted invoice page (org-checked). §4.1.
  app.get(
    "/api/v1/invoices/:id/hosted_url",
    { preHandler: [P("invoice.read")] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getInvoiceHostedUrl(actor, id);
    },
  );

  // GET /v1/invoices/:id/pdf — the invoice PDF url (proxied from Stripe with org check). §4.1.
  app.get("/api/v1/invoices/:id/pdf", { preHandler: [P("invoice.read")] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(IdParamsSchema, request.params);
    return service.getInvoicePdfUrl(actor, id);
  });

  // GET /v1/usage/current — current-period usage summary. §4.1.
  app.get("/api/v1/usage/current", { preHandler: [P("usage.read")] }, async (request) =>
    service.getUsageCurrent(actorOf(request)),
  );

  // GET /v1/usage/history — historical usage by period. §4.1.
  app.get("/api/v1/usage/history", { preHandler: [P("usage.read")] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(ListQuerySchema, request.query);
    return service.getUsageHistory(actor, q.cursor, q.limit);
  });

  // GET /v1/billing/status — lightweight billing status (frontend chrome). §4.1. Under the read-audit-
  // governed `/api/v1/billing` prefix → no-PHI waiver (subscription/dunning state only, §8.5).
  app.get(
    "/api/v1/billing/status",
    {
      preHandler: [P("subscription.read")],
      config: {
        auditRead: {
          none: "billing status is subscription/dunning lifecycle state; carries no PHI (§8.5)",
        },
      },
    },
    async (request) => service.getBillingStatus(actorOf(request)),
  );
}
