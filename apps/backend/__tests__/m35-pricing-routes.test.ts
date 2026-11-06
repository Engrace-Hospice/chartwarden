// apps/backend/__tests__/m35-pricing-routes.test.ts — slice 2 (tenant pricing) HTTP-layer wiring.
//
// Drives every route through Fastify `.inject()` behind the REAL Authorization Contract with the REAL default grants of the platform-ops
// roles (`PLATFORM_OPS_ROLE_GRANTS`), so a key that is not granted to the role that needs it, a guard that is missing from a write, or a body
// TypeBox does not bound fails here. The services are canned: this file proves the wiring and the guards, the live suite proves the data.
import { randomUUID } from "node:crypto";
import {
  PLATFORM_OPS_ROLE_GRANTS,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM35AbacPredicates, mountM35Routes } from "../src/modules/35-subscription/index";
import type {
  ContractService,
  PlatformContractView,
} from "../src/modules/35-subscription/pricing/contract-service";
import type {
  PricingPlanService,
  PricingPlanView,
} from "../src/modules/35-subscription/pricing/plan-service";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  const kind = request.headers["x-test-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

const PLATFORM_ORG = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const TENANT_ORG = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const OPS_MEMBERSHIP = "33333333-3333-4333-8333-cccccccccccc";
const PLAN_ID = "44444444-4444-4444-8444-dddddddddddd";
const SUB_ID = "55555555-5555-4555-8555-eeeeeeeeeeee";

const plan: PricingPlanView = {
  id: PLAN_ID,
  familySlug: "hospice-standard",
  version: 1,
  slug: "hospice-standard-v1",
  name: "Hospice standard",
  description: null,
  status: "published",
  offered: true,
  currencyCode: "USD",
  perUserPriceCents: 10_000,
  bands: [
    { minAdc: 0, maxAdc: 9, monthlyFeeCents: 100_000 },
    { minAdc: 10, maxAdc: 16, monthlyFeeCents: 200_000 },
    { minAdc: 17, maxAdc: 25, monthlyFeeCents: 300_000 },
    { minAdc: 26, maxAdc: 29, monthlyFeeCents: 400_000 },
    { minAdc: 30, maxAdc: null, monthlyFeeCents: 500_000 },
  ],
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  contractTermMonths: 12,
  implementationFeeCents: 250_000,
  minimumMonthlyCents: null,
  supersedesPlanId: null,
  publishedAt: "2026-11-05T00:00:00.000Z",
  archivedAt: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

const contract: PlatformContractView = {
  subscriptionId: SUB_ID,
  plan: { id: PLAN_ID, slug: plan.slug, name: plan.name, version: 1, currencyCode: "USD" },
  billingServiceMode: "billing_software",
  billingBps: 100,
  pendingBillingServiceMode: null,
  contractStartOn: "2026-11-05",
  contractTermMonths: 12,
  contractEndsOn: "2027-11-05",
  perUserPriceCents: 10_000,
  bands: plan.bands,
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  implementationFeeCents: 250_000,
  minimumMonthlyCents: null,
  signedByMembershipId: OPS_MEMBERSHIP,
  signedReason: "order form signed by the customer",
  orderFormRef: null,
};

interface Calls {
  readonly created: unknown[];
  readonly planWrites: unknown[];
  readonly tenantReads: unknown[];
  readonly platformReads: unknown[];
}

function makeServices(calls: Calls): { plans: PricingPlanService; contracts: ContractService } {
  const plans: PricingPlanService = {
    list: async () => [plan],
    get: async () => plan,
    listOffered: async () => [plan],
    create: async (actor, input, reason) => {
      calls.planWrites.push({ op: "create", actor, input, reason });
      return { ...plan, status: "draft", offered: false, publishedAt: null };
    },
    replaceDraft: async (actor, id, input, reason) => {
      calls.planWrites.push({ op: "replace", actor, id, input, reason });
      return { ...plan, status: "draft", offered: false, publishedAt: null };
    },
    publish: async (actor, id, reason) => {
      calls.planWrites.push({ op: "publish", actor, id, reason });
      return plan;
    },
    newVersion: async (actor, id, reason) => {
      calls.planWrites.push({ op: "new-version", actor, id, reason });
      return { ...plan, version: 2, slug: "hospice-standard-v2", status: "draft", offered: false };
    },
    archive: async (actor, id, reason) => {
      calls.planWrites.push({ op: "archive", actor, id, reason });
      return { ...plan, status: "archived", offered: false };
    },
  };
  const contracts: ContractService = {
    createForTenant: async (actor, orgSlug, input) => {
      calls.created.push({ actor, orgSlug, input });
      return { contract, resumed: false, planContractStep: { status: "settled" } };
    },
    setBillingServiceMode: async (_actor, _slug, mode) => ({
      ...contract,
      billingServiceMode: mode,
    }),
    platformView: async (actor, orgSlug) => {
      calls.platformReads.push({ actor, orgSlug });
      return { contract, statements: [] };
    },
    tenantView: async (organizationId, userId) => {
      calls.tenantReads.push({ organizationId, userId });
      const {
        signedByMembershipId: _a,
        signedReason: _b,
        orderFormRef: _c,
        ...tenantSafe
      } = contract;
      return { contract: tenantSafe, latestStatement: null };
    },
    billingServiceModeForOrg: async () => "billing_software",
  };
  return { plans, contracts };
}

const grantsOf = (role: keyof typeof PLATFORM_OPS_ROLE_GRANTS) => [
  ...PLATFORM_OPS_ROLE_GRANTS[role],
];

function makeServer() {
  const calls: Calls = { created: [], planWrites: [], tenantReads: [], platformReads: [] };
  const store = createInMemoryEffectivePermissionStore([
    {
      orgId: PLATFORM_ORG,
      userId: "ops",
      grants: [
        {
          roleKey: "platform_ops",
          enabled: true,
          expiresAt: null,
          permissionKeys: grantsOf("platform_ops"),
        },
      ],
    },
    {
      orgId: PLATFORM_ORG,
      userId: "billing",
      grants: [
        {
          roleKey: "platform_billing_admin",
          enabled: true,
          expiresAt: null,
          permissionKeys: grantsOf("platform_billing_admin"),
        },
      ],
    },
    {
      orgId: PLATFORM_ORG,
      userId: "owner",
      grants: [
        {
          roleKey: "platform_owner",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...grantsOf("platform_owner"), "subscription.onboard_platform"],
        },
      ],
    },
    {
      orgId: TENANT_ORG,
      userId: "tenant_admin",
      grants: [
        {
          roleKey: "org_admin",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["subscription.read"],
        },
      ],
    },
    {
      orgId: TENANT_ORG,
      userId: "tenant_none",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(store.store);

  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM35AbacPredicates()))
    reg.register(name, predicate);
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  // M34 owns the real predicate (the exact `platform_ops` role); this stand-in mirrors it so M35's wiring is exercised without M34.
  reg.register("tenant_lifecycle_platform_ops", async (context) =>
    context.roles.includes("platform_ops"),
  );
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const services = makeServices(calls);
  mountM35Routes(app, {
    service: {} as never,
    pricing: services,
  });
  return { app, calls };
}

const OPS = {
  "x-test-user": "ops",
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
  "x-test-membership": OPS_MEMBERSHIP,
  "x-test-step-up": "1",
};
const BILLING = {
  "x-test-user": "billing",
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_billing_admin",
  "x-test-membership": OPS_MEMBERSHIP,
  "x-test-step-up": "1",
};
const OWNER = {
  "x-test-user": "owner",
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_owner",
  "x-test-membership": OPS_MEMBERSHIP,
  "x-test-step-up": "1",
};
const idem = () => ({ "idempotency-key": randomUUID() });

const CONTRACT_BODY = {
  planSlug: "hospice-standard-v1",
  billingServiceMode: "billing_software",
  reason: "order form signed by the customer",
};
const PLAN_BODY = {
  familySlug: "hospice-standard",
  name: "Hospice standard",
  perUserPriceCents: 10_000,
  bands: [
    { minAdc: 0, monthlyFeeCents: 100_000 },
    { minAdc: 10, monthlyFeeCents: 200_000 },
  ],
  billingSoftwareBps: 100,
  managedBillingBps: 400,
  contractTermMonths: 12,
  implementationFeeCents: 250_000,
  minimumMonthlyCents: null,
  reason: "the 2027 standard price list",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("onboarding step 2: POST /api/v1/platform/tenants/:orgSlug/subscription", () => {
  const url = "/api/v1/platform/tenants/acme-hospice/subscription";

  it("platform_ops signs the tenant; the tenant is the PATH slug and the operator is the session, never the body", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...OPS, ...idem() },
      payload: CONTRACT_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ resumed: false, planContractStep: { status: "settled" } });
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({
      orgSlug: "acme-hospice",
      actor: { userId: "ops", membershipId: OPS_MEMBERSHIP },
      input: { planSlug: "hospice-standard-v1", billingServiceMode: "billing_software" },
    });
  });

  it("refuses a body that names an organisation, a membership or any field the route does not take", async () => {
    const { app, calls } = makeServer();
    for (const extra of [
      { organizationId: TENANT_ORG },
      { signedByMembershipId: OPS_MEMBERSHIP },
      { tenantAccountId: SUB_ID },
    ]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...OPS, ...idem() },
        payload: { ...CONTRACT_BODY, ...extra },
      });
      expect(res.statusCode).toBe(422);
    }
    expect(calls.created).toHaveLength(0);
  });

  it("refuses an unknown billing service mode", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...OPS, ...idem() },
      payload: { ...CONTRACT_BODY, billingServiceMode: "free" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("needs an Idempotency-Key", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({ method: "POST", url, headers: OPS, payload: CONTRACT_BODY });
    expect(res.statusCode).toBe(400);
    expect(calls.created).toHaveLength(0);
  });

  it("needs a fresh step-up", async () => {
    const { app, calls } = makeServer();
    const { "x-test-step-up": _drop, ...stale } = OPS;
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...stale, ...idem() },
      payload: CONTRACT_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(calls.created).toHaveLength(0);
  });

  it("is a human act: an AI principal is refused", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...OPS, ...idem(), "x-test-actor-kind": "ai_agent" },
      payload: CONTRACT_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(calls.created).toHaveLength(0);
  });

  it("is platform_ops alone: a billing admin has no key, and even a key on platform_owner is denied by the lifecycle predicate", async () => {
    const { app, calls } = makeServer();
    for (const headers of [BILLING, OWNER]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, ...idem() },
        payload: CONTRACT_BODY,
      });
      expect(res.statusCode).toBe(403);
    }
    expect(calls.created).toHaveLength(0);
  });

  it("a tenant session cannot reach it", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: {
        "x-test-user": "tenant_admin",
        "x-test-org": TENANT_ORG,
        "x-test-roles": "org_admin",
        "x-test-membership": OPS_MEMBERSHIP,
        "x-test-step-up": "1",
        ...idem(),
      },
      payload: CONTRACT_BODY,
    });
    expect(res.statusCode).toBe(403);
  });

  it("the billing service mode change carries the same guards", async () => {
    const { app } = makeServer();
    const mode = `${url}/billing-service-mode`;
    const body = {
      billingServiceMode: "none",
      reason: "the tenant moved its billing out of ChartWarden",
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: mode,
          headers: { ...OPS, ...idem() },
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "PUT", url: mode, headers: OPS, payload: body })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: mode,
          headers: { ...BILLING, ...idem() },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe("the platform pricing reads and the price preview", () => {
  it("platform_ops and the billing roles read the offered plans; a tenant cannot", async () => {
    const { app } = makeServer();
    for (const headers of [OPS, BILLING]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/platform/pricing/plans",
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    }
    const tenant = await app.inject({
      method: "GET",
      url: "/api/v1/platform/pricing/plans",
      headers: {
        "x-test-user": "tenant_admin",
        "x-test-org": TENANT_ORG,
        "x-test-roles": "org_admin",
      },
    });
    expect(tenant.statusCode).toBe(403);
  });

  it("previews with the same math a statement uses, and shows both sides of the greater-of rule", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/pricing/preview",
      headers: OPS,
      payload: {
        planId: PLAN_ID,
        staffCount: 30,
        averageDailyCensus: 12.4,
        expectedNetCollectionsCents: 10_000_000,
        billingServiceMode: "managed_billing",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.platformFee).toMatchObject({
      perUserSubtotalCents: 300_000,
      bandFeeCents: 200_000,
      bandMinAdc: 10,
      bandMaxAdc: 16,
      feeCents: 300_000,
      basis: "per_user",
    });
    expect(body.billing).toEqual({ mode: "managed_billing", bps: 400, feeCents: 400_000 });
    expect(body.monthlyCents).toBe(700_000);
    expect(body.firstMonthCents).toBe(950_000);
  });

  it("prices the FIRST month by the days live from a planned go-live date: Nov 20 is 11 of 30 days (the go-live day counts)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/pricing/preview",
      headers: OPS,
      payload: {
        planId: PLAN_ID,
        staffCount: 0,
        averageDailyCensus: 12,
        expectedNetCollectionsCents: 0,
        billingServiceMode: "none",
        plannedGoLiveOn: "2026-11-20",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // a full month on the $2,000 band is $2,000; 11/30 of it is $733.33; the implementation fee is added whole
    expect(body.monthlyCents).toBe(200_000);
    expect(body.firstMonthDaysLive).toBe(11);
    expect(body.firstMonthDaysInPeriod).toBe(30);
    expect(body.firstMonthCents).toBe(73_333 + 250_000);
  });

  it("a go-live on the 1st is a whole first month, and on the last day it is one day; a date that does not exist is refused", async () => {
    const { app } = makeServer();
    const preview = (plannedGoLiveOn: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/platform/pricing/preview",
        headers: OPS,
        payload: {
          planId: PLAN_ID,
          staffCount: 0,
          averageDailyCensus: 12,
          expectedNetCollectionsCents: 0,
          billingServiceMode: "none",
          plannedGoLiveOn,
        },
      });
    expect((await preview("2026-11-01")).json().firstMonthCents).toBe(200_000 + 250_000);
    expect((await preview("2026-11-30")).json().firstMonthCents).toBe(6_667 + 250_000);
    expect((await preview("2026-02-31")).statusCode).toBe(422);
  });

  it("bounds staff x per-user price below 2^53: a per-user price above the cap is refused on a plan write", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/pricing/plans",
      headers: { ...BILLING, ...idem() },
      payload: { ...PLAN_BODY, perUserPriceCents: 1_000_000_001 },
    });
    expect(res.statusCode).toBe(422);
    // 1,000,000 staff x the cap is exactly 10^15, which a double holds exactly
    expect(1_000_000 * 1_000_000_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("prices a tenant that bills outside ChartWarden with no percentage", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/pricing/preview",
      headers: OPS,
      payload: {
        planId: PLAN_ID,
        staffCount: 1,
        averageDailyCensus: 3,
        expectedNetCollectionsCents: 99_999_999,
        billingServiceMode: "none",
      },
    });
    expect(res.json().billing).toEqual({ mode: "none", bps: 0, feeCents: 0 });
  });

  it("refuses an out-of-range input rather than pricing it", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/pricing/preview",
      headers: OPS,
      payload: {
        planId: PLAN_ID,
        staffCount: -1,
        averageDailyCensus: 3,
        expectedNetCollectionsCents: 0,
        billingServiceMode: "none",
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("the platform read of a tenant's pricing: GET /api/v1/platform/tenants/:orgSlug/subscription", () => {
  const url = "/api/v1/platform/tenants/acme-hospice/subscription";

  it("hands the SESSION's operator to the service, which writes the read-audit row naming operator and tenant", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({ method: "GET", url, headers: OPS });
    expect(res.statusCode).toBe(200);
    expect(calls.platformReads).toEqual([
      {
        actor: expect.objectContaining({ userId: "ops", membershipId: OPS_MEMBERSHIP }),
        orgSlug: "acme-hospice",
      },
    ]);
  });

  it("a tenant cannot read it", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "GET",
      url,
      headers: {
        "x-test-user": "tenant_admin",
        "x-test-org": TENANT_ORG,
        "x-test-roles": "org_admin",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.platformReads).toHaveLength(0);
  });
});

describe("the plan editor: /api/admin/pricing/plans", () => {
  it("billing admins read and write; platform_ops (no plan key) does not", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/pricing/plans", headers: BILLING }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/pricing/plans", headers: OPS }))
        .statusCode,
    ).toBe(403);
    const create = await app.inject({
      method: "POST",
      url: "/api/admin/pricing/plans",
      headers: { ...OPS, ...idem() },
      payload: PLAN_BODY,
    });
    expect(create.statusCode).toBe(403);
  });

  it("every write needs step-up, an Idempotency-Key, a human actor and a reason", async () => {
    const { app, calls } = makeServer();
    const post = (headers: Record<string, string>, payload: object = PLAN_BODY) =>
      app.inject({ method: "POST", url: "/api/admin/pricing/plans", headers, payload });
    expect((await post({ ...BILLING, ...idem() })).statusCode).toBe(201);
    expect((await post(BILLING)).statusCode).toBe(400);
    const { "x-test-step-up": _drop, ...stale } = BILLING;
    expect((await post({ ...stale, ...idem() })).statusCode).toBe(403);
    expect(
      (await post({ ...BILLING, ...idem(), "x-test-actor-kind": "ai_agent" })).statusCode,
    ).toBe(403);
    const { reason: _r, ...noReason } = PLAN_BODY;
    expect((await post({ ...BILLING, ...idem() }, noReason)).statusCode).toBe(422);
    expect(calls.planWrites).toHaveLength(1);
  });

  it("draft edit, publish, new version and archive each reach the service with the session's operator", async () => {
    const { app, calls } = makeServer();
    const reason = { reason: "annual price review" };
    const put = await app.inject({
      method: "PUT",
      url: `/api/admin/pricing/plans/${PLAN_ID}`,
      headers: { ...BILLING, ...idem() },
      payload: (({ familySlug: _f, ...rest }) => rest)(PLAN_BODY),
    });
    expect(put.statusCode).toBe(200);
    for (const [op, status] of [
      ["publish", 200],
      ["new-version", 201],
      ["archive", 200],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/pricing/plans/${PLAN_ID}/${op}`,
        headers: { ...BILLING, ...idem() },
        payload: reason,
      });
      expect(res.statusCode, op).toBe(status);
    }
    expect(calls.planWrites.map((w) => (w as { op: string }).op)).toEqual([
      "replace",
      "publish",
      "new-version",
      "archive",
    ]);
    expect(calls.planWrites[0]).toMatchObject({
      actor: { userId: "billing", membershipId: OPS_MEMBERSHIP },
    });
  });

  it("refuses a band outside the safe money range and a plan body with an unknown field", async () => {
    const { app } = makeServer();
    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/api/admin/pricing/plans",
        headers: { ...BILLING, ...idem() },
        payload,
      });
    expect(
      (await post({ ...PLAN_BODY, bands: [{ minAdc: 0, monthlyFeeCents: -1 }] })).statusCode,
    ).toBe(422);
    expect(
      (await post({ ...PLAN_BODY, bands: [{ minAdc: 0, monthlyFeeCents: 1.5 }] })).statusCode,
    ).toBe(422);
    expect((await post({ ...PLAN_BODY, billingSoftwareBps: 10_001 })).statusCode).toBe(422);
    expect((await post({ ...PLAN_BODY, isActive: true })).statusCode).toBe(422);
  });

  it("serves the default band thresholds as a form's starting point", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/pricing/defaults",
      headers: BILLING,
    });
    // the owner's five bands: 0-9, 10-16, 17-25, 26-29, 30+
    expect(res.json()).toEqual({ bandThresholds: [0, 10, 17, 26, 30], currencyCode: "USD" });
  });
});

describe("the tenant read: GET /api/v1/subscription/pricing", () => {
  const url = "/api/v1/subscription/pricing";
  const tenant = {
    "x-test-user": "tenant_admin",
    "x-test-org": TENANT_ORG,
    "x-test-roles": "org_admin",
  };

  it("a tenant reads ITS OWN plan, by its session's organisation, with no operator identity in it", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({ method: "GET", url, headers: tenant });
    expect(res.statusCode).toBe(200);
    expect(calls.tenantReads).toEqual([{ organizationId: TENANT_ORG, userId: "tenant_admin" }]);
    const body = res.json();
    expect(body.contract.billingServiceMode).toBe("billing_software");
    for (const operatorField of ["signedByMembershipId", "signedReason", "orderFormRef"]) {
      expect(body.contract).not.toHaveProperty(operatorField);
    }
  });

  it("is read-only: there is no write verb on it", async () => {
    const { app } = makeServer();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url, headers: tenant, payload: {} });
      expect(res.statusCode, method).toBe(404);
    }
  });

  it("needs subscription.read", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url,
      headers: { "x-test-user": "tenant_none", "x-test-org": TENANT_ORG, "x-test-roles": "" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s with no session", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });
});
