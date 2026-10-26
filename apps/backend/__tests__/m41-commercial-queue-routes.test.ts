// M41 work queue and supported-payers reads (issue #726) over the route stack and the REAL Authorization Contract, with a
// recording fake for the read service (the SQL is proven by m41-commercial-routes.live.test.ts):
//   permission (403), session (401), provider-entity scope (404, never 403), strict query (422), the payer-kind filter reaches the
//   service, and the list read is audited as a list.
import {
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
import { registerCommercialBillingRoutes } from "../src/modules/41-billing-commercial/routes/commercial-billing.routes";
import type { CommercialClaimReadService } from "../src/modules/41-billing-commercial/services/claim-read-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const OTHER_PE = "22222222-2222-4222-8222-999999999999";
const KEYS: Record<string, string[]> = { biller: ["commercial_billing.read"], nobody: [] };

let listCalls: unknown[] = [];

const reads = {
  listClaims: async (_actor: unknown, filter: unknown) => {
    listCalls.push(filter);
    return { items: [], hasMore: false, nextCursor: null };
  },
  listPlans: async () => ({ items: [] }),
  getClaim: async () => {
    throw new Error("unused");
  },
} as unknown as CommercialClaimReadService;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register(
    "commercial_billing_provider_scope",
    async (_ctx, target) => (target as { providerEntityId?: string }).providerEntityId === PE,
  );
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerCommercialBillingRoutes(app, {
    reads,
    assembly: {} as never,
    lifecycle: {} as never,
    authorizations: {} as never,
    submissions: {} as never,
  });
  return app;
}

beforeEach(() => {
  listCalls = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

const QUEUE = "/api/v1/billing/commercial/claims";
const PLANS = "/api/v1/billing/commercial/payer-plans";
const as = (user: string) => ({ "x-test-user": user });

describe("GET /billing/commercial/claims (work queue)", () => {
  it("answers 200 and passes the payer-kind and state filters to the service", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${QUEUE}?providerEntityId=${PE}&payerKind=medicare_secondary&state=draft`,
      headers: as("biller"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], hasMore: false, nextCursor: null });
    expect(listCalls).toEqual([
      { providerEntityId: PE, payerKind: "medicare_secondary", state: "draft" },
    ]);
  });

  it("is 401 without a session and 403 without the permission", async () => {
    const app = makeServer();
    expect(
      (await app.inject({ method: "GET", url: `${QUEUE}?providerEntityId=${PE}` })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${QUEUE}?providerEntityId=${PE}`,
          headers: as("nobody"),
        })
      ).statusCode,
    ).toBe(403);
  });

  it("is 404 (not 403) for a provider entity outside the actor's scope", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${QUEUE}?providerEntityId=${OTHER_PE}`,
      headers: as("biller"),
    });
    expect(res.statusCode).toBe(404);
    expect(listCalls).toEqual([]);
  });

  it("refuses an unknown payer kind and an unknown query key (422)", async () => {
    const app = makeServer();
    for (const q of ["payerKind=cash", "unknown=1"]) {
      const res = await app.inject({
        method: "GET",
        url: `${QUEUE}?providerEntityId=${PE}&${q}`,
        headers: as("biller"),
      });
      expect(res.statusCode).toBe(422);
    }
  });
});

describe("GET /billing/commercial/payer-plans (supported payers)", () => {
  it("answers 200 for a scoped reader and 403 for a user without the permission", async () => {
    const app = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: `${PLANS}?providerEntityId=${PE}`,
      headers: as("biller"),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ items: [] });
    const denied = await app.inject({
      method: "GET",
      url: `${PLANS}?providerEntityId=${PE}`,
      headers: as("nobody"),
    });
    expect(denied.statusCode).toBe(403);
  });
});
