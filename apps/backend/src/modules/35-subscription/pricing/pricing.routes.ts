// apps/backend/src/modules/35-subscription/pricing/pricing.routes.ts — slice 2 (tenant pricing) routes.
//
//   plan editor (platform billing roles; `plan.admin.read|write`, `platform_billing_scope`)
//     GET  /api/admin/pricing/defaults                      default band thresholds (a form's starting point, never a price)
//     GET  /api/admin/pricing/plans[/:id]                    every census_banded version, drafts and archived included
//     POST /api/admin/pricing/plans                          create a draft (version 1 of a new family)
//     PUT  /api/admin/pricing/plans/:id                      replace a draft's prices and bands
//     POST /api/admin/pricing/plans/:id/publish|new-version|archive
//   onboarding (platform ops; `subscription.pricing_read_platform` / `subscription.onboard_platform`)
//     GET  /api/v1/platform/pricing/plans                    the published, current versions an operator may sign
//     POST /api/v1/platform/pricing/preview                  the price of a plan for entered inputs (no write)
//     GET  /api/v1/platform/tenants/:orgSlug/subscription    a tenant's contract and statements
//     POST /api/v1/platform/tenants/:orgSlug/subscription    onboarding step 2: sign the tenant and settle `plan_contract`
//     PUT  /api/v1/platform/tenants/:orgSlug/subscription/billing-service-mode
//   tenant (`subscription.read`)
//     GET  /api/v1/subscription/pricing                      the tenant's own plan terms and latest statement (read-only)
//
// EVERY WRITE: the permission, its ABAC predicate, a FRESH step-up, the AI-actor block (pricing is a person's decision), an
// `Idempotency-Key` and a recorded reason. The operator is the session; the tenant is the PATH slug, never the body.
import { requireAbac } from "@chartwarden/auth";
import { DEFAULT_CENSUS_BAND_THRESHOLDS } from "@chartwarden/subscription-billing";
import type { FastifyInstance } from "fastify";
import { rejectAiActor } from "../../../bootstrap/reject-ai-actor";
import { actorOf, writeActorOf } from "../routes/actor";
import { IDEMPOTENT, P, PLATFORM_SCOPE, STEP_UP } from "../routes/guards";
import type { ContractService } from "./contract-service";
import type { PlanPricingInput, PricingPlanService } from "./plan-service";
import { buildPricePreview } from "./preview";
import {
  CreatePricingPlanBody,
  CreateTenantContractBody,
  OrgSlugParams,
  PricePreviewBody,
  PricingPlanParams,
  PricingReasonBody,
  ReplacePricingDraftBody,
  SetBillingServiceModeBody,
  parseStrict as parse,
} from "./pricing-typebox";

export interface PricingRouteDeps {
  readonly plans: PricingPlanService;
  readonly contracts: ContractService;
}

const PLAN_READ = "plan.admin.read";
const PLAN_WRITE = "plan.admin.write";
const PRICING_READ = "subscription.pricing_read_platform";
const ONBOARD = "subscription.onboard_platform";
const TENANT_LIFECYCLE_OPS = "tenant_lifecycle_platform_ops";
/** The plan currency a form defaults to; a plan stores its own. */
const DEFAULT_CURRENCY = "USD";

type Preflight = ReturnType<typeof P>;
const PLAN_READ_GUARDS: Preflight[] = [P(PLAN_READ), PLATFORM_SCOPE(PLAN_READ)];
const PLAN_WRITE_GUARDS: Preflight[] = [
  P(PLAN_WRITE),
  PLATFORM_SCOPE(PLAN_WRITE),
  STEP_UP(PLAN_WRITE),
  rejectAiActor("AI principals cannot change a plan's prices") as Preflight,
  IDEMPOTENT,
];
const PRICING_READ_GUARDS: Preflight[] = [P(PRICING_READ), PLATFORM_SCOPE(PRICING_READ)];
const ONBOARD_GUARDS: Preflight[] = [
  P(ONBOARD),
  requireAbac(ONBOARD, TENANT_LIFECYCLE_OPS) as Preflight,
  STEP_UP(ONBOARD),
  rejectAiActor(
    "AI principals cannot sign a tenant's plan or change its billing service",
  ) as Preflight,
  IDEMPOTENT,
];

const toInput = (body: {
  name: string;
  description?: string | null | undefined;
  currencyCode?: string | undefined;
  perUserPriceCents: number;
  bands: { minAdc: number; monthlyFeeCents: number }[];
  billingSoftwareBps: number;
  managedBillingBps: number;
  contractTermMonths: number;
  implementationFeeCents: number;
  minimumMonthlyCents: number | null;
}): PlanPricingInput => ({
  name: body.name,
  description: body.description ?? null,
  ...(body.currencyCode ? { currencyCode: body.currencyCode } : {}),
  perUserPriceCents: body.perUserPriceCents,
  bands: body.bands,
  billingSoftwareBps: body.billingSoftwareBps,
  managedBillingBps: body.managedBillingBps,
  contractTermMonths: body.contractTermMonths,
  implementationFeeCents: body.implementationFeeCents,
  minimumMonthlyCents: body.minimumMonthlyCents,
});

export function registerPricingRoutes(app: FastifyInstance, deps: PricingRouteDeps): void {
  const { plans, contracts } = deps;

  // ── plan editor ──
  app.get("/api/admin/pricing/defaults", { preHandler: PLAN_READ_GUARDS }, async () => ({
    bandThresholds: [...DEFAULT_CENSUS_BAND_THRESHOLDS],
    currencyCode: DEFAULT_CURRENCY,
  }));
  app.get("/api/admin/pricing/plans", { preHandler: PLAN_READ_GUARDS }, async () => plans.list());
  app.get("/api/admin/pricing/plans/:id", { preHandler: PLAN_READ_GUARDS }, async (request) =>
    plans.get(parse(PricingPlanParams, request.params).id),
  );
  app.post(
    "/api/admin/pricing/plans",
    { preHandler: PLAN_WRITE_GUARDS },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(CreatePricingPlanBody, request.body);
      return reply
        .code(201)
        .send(
          await plans.create(actor, { familySlug: body.familySlug, ...toInput(body) }, body.reason),
        );
    },
  );
  app.put("/api/admin/pricing/plans/:id", { preHandler: PLAN_WRITE_GUARDS }, async (request) => {
    const actor = writeActorOf(request);
    const { id } = parse(PricingPlanParams, request.params);
    const body = parse(ReplacePricingDraftBody, request.body);
    return plans.replaceDraft(actor, id, toInput(body), body.reason);
  });
  app.post(
    "/api/admin/pricing/plans/:id/publish",
    { preHandler: PLAN_WRITE_GUARDS },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(PricingPlanParams, request.params);
      return plans.publish(actor, id, parse(PricingReasonBody, request.body).reason);
    },
  );
  app.post(
    "/api/admin/pricing/plans/:id/new-version",
    { preHandler: PLAN_WRITE_GUARDS },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(PricingPlanParams, request.params);
      return reply
        .code(201)
        .send(await plans.newVersion(actor, id, parse(PricingReasonBody, request.body).reason));
    },
  );
  app.post(
    "/api/admin/pricing/plans/:id/archive",
    { preHandler: PLAN_WRITE_GUARDS },
    async (request) => {
      const actor = writeActorOf(request);
      const { id } = parse(PricingPlanParams, request.params);
      return plans.archive(actor, id, parse(PricingReasonBody, request.body).reason);
    },
  );

  // ── onboarding: pick a plan, preview its price, sign the tenant ──
  app.get("/api/v1/platform/pricing/plans", { preHandler: PRICING_READ_GUARDS }, async () =>
    plans.listOffered(),
  );
  app.post(
    "/api/v1/platform/pricing/preview",
    { preHandler: PRICING_READ_GUARDS },
    async (request) => {
      const body = parse(PricePreviewBody, request.body);
      return buildPricePreview(await plans.get(body.planId), {
        staffCount: body.staffCount,
        averageDailyCensus: body.averageDailyCensus,
        expectedNetCollectionsCents: body.expectedNetCollectionsCents,
        billingServiceMode: body.billingServiceMode,
      });
    },
  );
  app.get(
    "/api/v1/platform/tenants/:orgSlug/subscription",
    { preHandler: PRICING_READ_GUARDS },
    async (request) => contracts.platformView(parse(OrgSlugParams, request.params).orgSlug),
  );
  app.post(
    "/api/v1/platform/tenants/:orgSlug/subscription",
    { preHandler: ONBOARD_GUARDS },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { orgSlug } = parse(OrgSlugParams, request.params);
      const body = parse(CreateTenantContractBody, request.body);
      return reply.code(201).send(await contracts.createForTenant(actor, orgSlug, body));
    },
  );
  app.put(
    "/api/v1/platform/tenants/:orgSlug/subscription/billing-service-mode",
    { preHandler: ONBOARD_GUARDS },
    async (request) => {
      const actor = writeActorOf(request);
      const { orgSlug } = parse(OrgSlugParams, request.params);
      const body = parse(SetBillingServiceModeBody, request.body);
      return contracts.setBillingServiceMode(actor, orgSlug, body.billingServiceMode, body.reason);
    },
  );

  // ── tenant: its own plan and latest statement ──
  app.get(
    "/api/v1/subscription/pricing",
    { preHandler: [P("subscription.read")] },
    async (request) => {
      const actor = actorOf(request);
      return contracts.tenantView(actor.organizationId, actor.userId);
    },
  );
}
