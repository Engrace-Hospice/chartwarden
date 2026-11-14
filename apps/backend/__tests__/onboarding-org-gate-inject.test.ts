// A not-yet-live organization's billing steps are reachable through the REAL authenticate hook and the REAL route plugins.
//
// `onboarding-org-gate.test.ts` decides pairs on a bare template and `onboarding-org-gate-routes.test.ts` checks every entry names
// a real route. Neither sends a request. This does: a `created` organization's org_admin session (the real
// `createSessionAuthenticate`, confined by a stage reader that says "not live" and "created") calls each billing-step route the
// allowlist opened (the tenant clearinghouse, the MAC credential routes, the pricing read) through the real route plugins and gets
// 200/201; a write without its Idempotency-Key gets the route's own 400, so the route's own pre-handlers do run.
//
// What is real and what is stubbed, so the test claims no more than it proves: the authenticate hook, the gate, the route plugins,
// their guards' wiring and the Idempotency-Key and body checks are real. The permission keys the session holds are the ones the REAL
// org_admin role template grants (derived from the template planner, so a key org_admin lacks fails here); the step-up and
// provider-entity-scope predicates are registered as always-true, and the services behind the routes are stubs, so this does NOT
// prove a fresh step-up or a provider-entity scope is satisfied by a real org_admin (the live suites do).
//
// The same session can inspect existing support consent (a safety route) but still gets 403 ORGANIZATION_ONBOARDING on a clinical
// route. The billing steps are refused to every confined stage but `created`, and once the organization is live the gate steps
// aside (so each refusal is the gate's doing, not the fixture's).
import {
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  planRoleTemplateMaterialization,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  type ResolvedActor,
  STEP_UP_POLICY,
  type SessionContextResolver,
} from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { registerMacCredentialRoutes } from "../src/modules/23-billing-medicare/routes/mac-credentials.routes";
import type { M23ReadRouteService } from "../src/modules/23-billing-medicare/routes/read-service";
import type { M23WriteRouteService } from "../src/modules/23-billing-medicare/routes/write-service";
import { registerTenantClearinghouseRoutes } from "../src/modules/23-billing-medicare/tenant-clearinghouse/routes";
import type { TenantClearinghouseRouteService } from "../src/modules/23-billing-medicare/tenant-clearinghouse/tenant-service";
import type { TenantRouteService } from "../src/modules/34-saas-tenant-platform/routes/tenant/service";
import { registerSupportConsentGrantRoutes } from "../src/modules/34-saas-tenant-platform/routes/tenant/support-consent-grants";
import { registerPricingRoutes } from "../src/modules/35-subscription/pricing/pricing.routes";

const ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ENTITY = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-11-09T12:00:00.000Z";

const actor: ResolvedActor = {
  userId: USER,
  membershipId: MEMBERSHIP,
  organizationId: ORG,
  roles: ["org_admin"],
  providerEntityIds: [],
  locationIds: [],
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
  deviceAttestation: null,
  externalActorId: null,
};
const resolver: SessionContextResolver = {
  resolveActor: async () => actor,
  resolveStepUpState: async () => null,
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
};

const VIEW = {
  vendor: "outside",
  mode: null,
  status: "active",
  hasSecret: false,
  version: 1,
} as const;
const clearinghouse = {
  get: async () => VIEW,
  put: async () => ({ created: true, view: VIEW }),
  recordBaa: async () => VIEW,
  verify: async () => ({ view: VIEW, test: null }),
  activate: async () => VIEW,
} as unknown as TenantClearinghouseRouteService;
const MAC_VIEW = {
  providerEntityId: PROVIDER_ENTITY,
  macJurisdiction: "cgs_j15",
  hasSecret: true,
  version: 1,
};
const macRead = {
  listMacCredentials: async () => ({ items: [MAC_VIEW], nextCursor: null, hasMore: false }),
  getMacCredential: async () => MAC_VIEW,
} as unknown as M23ReadRouteService;
const macWrite = {
  upsertMacCredential: async () => MAC_VIEW,
  testMacCredential: async () => ({
    providerEntityId: PROVIDER_ENTITY,
    macJurisdiction: "cgs_j15",
    ok: true,
    method: "portal_health_probe",
    detail: "ok",
    checkedAt: NOW,
    lastSandboxTestAt: NOW,
  }),
} as unknown as M23WriteRouteService;
const pricing = {
  plans: {} as never,
  contracts: { tenantView: async () => ({ contract: null, latestStatement: null }) } as never,
};
const consentGrants = {
  listConsentGrants: async () => ({ items: [], nextCursor: null, hasMore: false }),
} as unknown as TenantRouteService;

const BILLING_STEP_KEYS = [
  "billing.clearinghouse.read",
  "billing.clearinghouse.admin",
  "billing.mac_credential.read",
  "billing.mac_credential.admin",
  "subscription.read",
];
/** What the real org_admin template grants: the session holds exactly these (a permission org_admin lacks cannot be assumed here). */
const ORG_ADMIN_KEYS =
  planRoleTemplateMaterialization({
    templates: ROLE_TEMPLATES,
    existingRoleKeys: new Set<string>(),
    mirror: allPermissionMirrorRows().map((r) => ({ key: r.key, category: r.category })),
  }).find((role) => role.key === "org_admin")?.permissionKeys ?? [];
/** The keys the session holds: the billing steps' keys and the consent-grant read, each only if the real org_admin template has it. */
const KEYS = [...BILLING_STEP_KEYS, "support_consent_grant.list_own"].filter((key) =>
  ORG_ADMIN_KEYS.includes(key),
);

/** `created` is the onboarding case; `suspended` stands for every other confined status; `live` is an active organization. */
type Stage = "created" | "suspended" | "live";

function serverFor(stage: Stage) {
  const app = buildServer({
    authenticate: createSessionAuthenticate({
      getSnapshot: async () => ({
        sessionId: "session-1",
        userId: USER,
        activeOrganizationId: ORG,
      }),
      getResolver: () => resolver,
      organizationStage: {
        isConfined: async () => stage !== "live",
        isCreated: async () => stage === "created",
      },
    }),
    security: { rateLimitEnabled: false },
  });
  registerTenantClearinghouseRoutes(app, { tenantClearinghouseService: clearinghouse });
  registerMacCredentialRoutes(app, { readService: macRead, writeService: macWrite });
  registerPricingRoutes(app, pricing);
  registerSupportConsentGrantRoutes(app, { service: consentGrants });
  // A clinical route of the same shape: the gate decides on its template, not on what the handler is.
  app.get(
    "/api/v1/patients",
    { config: { auditRead: { none: "a stand-in route: the gate refuses it before any handler" } } },
    async () => ({ items: [] }),
  );
  return app;
}

let idempotency = 0;
const send = (
  app: ReturnType<typeof serverFor>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
) => {
  const headers: Record<string, string> =
    method === "GET" ? {} : { "idempotency-key": `onb-${++idempotency}` };
  if (url === "/api/v1/tenant/clearinghouse/baa" || url === "/api/v1/tenant/clearinghouse/verify") {
    headers["if-match"] = "1";
  }
  return app.inject({
    method,
    url,
    headers,
    ...(payload ? { payload } : {}),
  });
};

beforeEach(() => {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: USER,
        grants: [{ roleKey: "org_admin", enabled: true, expiresAt: null, permissionKeys: KEYS }],
      },
    ]).store,
  );
  const predicates = createPredicateRegistry();
  predicates.register("provider_entity_billing_scope", async () => true);
  predicates.register("step_up_recent", async () => true);
  registerAbacRegistry(predicates);
});
afterEach(() => {
  resetAbacRegistry();
  resetAuthorizationContract();
  resetRbacEngine();
});

const MAC_BODY = {
  providerEntityId: PROVIDER_ENTITY,
  macJurisdiction: "cgs_j15",
  submitterId: "SUB-1",
  tradingPartnerId: "TP-1",
  clientId: "client-1",
  clientSecret: "synthetic-mac-client-secret-0001",
};

describe("the session's permissions come from the real org_admin template", () => {
  it("the real org_admin template grants every key the billing steps need, and the consent-grant read", () => {
    for (const key of [...BILLING_STEP_KEYS, "support_consent_grant.list_own"]) {
      expect(ORG_ADMIN_KEYS, key).toContain(key);
    }
    expect(KEYS).toHaveLength(BILLING_STEP_KEYS.length + 1);
  });
});

describe("a created organization's admin reaches the billing steps through the real route plugins", () => {
  it.each([
    { method: "GET", url: "/api/v1/tenant/clearinghouse", status: 200 },
    {
      method: "PUT",
      url: "/api/v1/tenant/clearinghouse",
      payload: { vendor: "outside" },
      status: 201,
    },
    {
      method: "POST",
      url: "/api/v1/tenant/clearinghouse/baa",
      payload: { heldBy: "tenant", effectiveDate: "2026-01-02", documentRef: "BAA-folder-2026" },
      status: 200,
    },
    { method: "POST", url: "/api/v1/tenant/clearinghouse/verify", payload: {}, status: 200 },
    { method: "POST", url: "/api/v1/tenant/clearinghouse/activate", payload: {}, status: 200 },
    { method: "GET", url: "/api/v1/subscription/pricing", status: 200 },
    { method: "GET", url: "/api/v1/billing/mac-credentials", status: 200 },
    { method: "GET", url: `/api/v1/billing/mac-credentials/${PROVIDER_ENTITY}`, status: 200 },
    { method: "POST", url: "/api/v1/billing/mac-credentials", payload: MAC_BODY, status: 201 },
    {
      method: "POST",
      url: `/api/v1/billing/mac-credentials/${PROVIDER_ENTITY}/test`,
      payload: {},
      status: 200,
    },
  ] as const)("$method $url answers $status on a created organization", async (c) => {
    const app = serverFor("created");
    const res = await send(app, c.method, c.url, "payload" in c ? c.payload : undefined);
    expect(res.statusCode, res.body).toBe(c.status);
    await app.close();
  });

  it("a write without an Idempotency-Key is the route's own 400, not the organization gate's 403", async () => {
    const app = serverFor("created");
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/tenant/clearinghouse",
      payload: { vendor: "outside" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).not.toBe("ORGANIZATION_ONBOARDING");
    await app.close();
  });
});

describe("any other confined stage is refused the billing steps (the wizard routes stay open to it)", () => {
  it.each([
    ["GET", "/api/v1/tenant/clearinghouse"],
    ["PUT", "/api/v1/tenant/clearinghouse"],
    ["POST", "/api/v1/tenant/clearinghouse/activate"],
    ["GET", "/api/v1/subscription/pricing"],
    ["GET", "/api/v1/billing/mac-credentials"],
    ["POST", "/api/v1/billing/mac-credentials"],
    ["POST", `/api/v1/billing/mac-credentials/${PROVIDER_ENTITY}/test`],
  ] as const)(
    "%s %s answers 403 ORGANIZATION_ONBOARDING on a suspended organization",
    async (method, url) => {
      const app = serverFor("suspended");
      const res = await send(
        app,
        method,
        url,
        method === "GET" ? undefined : { vendor: "outside" },
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe("ORGANIZATION_ONBOARDING");
      await app.close();
    },
  );
});

describe("what a created organization still cannot reach", () => {
  it("keeps the support-consent safety read available", async () => {
    const app = serverFor("created");
    const res = await send(app, "GET", "/api/v1/tenant/support-consent-grants");
    expect(res.statusCode, res.body).toBe(200);
    await app.close();
  });

  it("keeps a clinical route closed", async () => {
    const app = serverFor("created");
    const res = await send(app, "GET", "/api/v1/patients");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ORGANIZATION_ONBOARDING");
    await app.close();
  });

  it("both routes answer 200 once the organization is live (so the clinical 403 above is the gate)", async () => {
    const app = serverFor("live");
    for (const url of ["/api/v1/tenant/support-consent-grants", "/api/v1/patients"]) {
      const res = await send(app, "GET", url);
      expect(res.statusCode, url).toBe(200);
    }
    await app.close();
  });
});
