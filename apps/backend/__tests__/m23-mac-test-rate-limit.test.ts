// `POST /api/v1/billing/mac-credentials/:providerEntityId/test` is an outbound call to the platform's own MAC gateway per request, and a
// created organization can now reach it. It is capped per user and per organization like the clearinghouse verify, and FAILS CLOSED:
// with the limiter's store down the route answers a typed 503 (DEGRADED) and never calls the gateway (7A security review L3).
// Real route plugin, real guards' wiring, real limiter; the write service is a recording stub.
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
import {
  type RateLimitStore,
  createInMemoryRateLimitStore,
} from "../src/bootstrap/plugins/rate-limit-store";
import {
  MAC_CREDENTIAL_TEST_ROUTE_RATE_LIMIT,
  createRouteRateLimit,
} from "../src/bootstrap/plugins/route-rate-limit";
import { registerMacCredentialRoutes } from "../src/modules/23-billing-medicare/routes/mac-credentials.routes";
import type { M23ReadRouteService } from "../src/modules/23-billing-medicare/routes/read-service";
import type { M23WriteRouteService } from "../src/modules/23-billing-medicare/routes/write-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const PE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const URL = `/api/v1/billing/mac-credentials/${PE}/test`;

function headerAuth(request: FastifyRequest): void {
  if (request.headers["x-test-user"] !== "admin") return;
  request.context.userId = USER;
  request.context.organizationId = ORG;
  request.context.roles = ["org_admin"];
  request.context.attributes.membershipId = MEMBERSHIP;
  request.context.attributes.stepUpRecent = true;
}

function makeServer(store: RateLimitStore | null, perUser = 2) {
  const probes: string[] = [];
  const writeService = {
    testMacCredential: async (_actor: unknown, providerEntityId: string) => {
      probes.push(providerEntityId);
      return { ok: true };
    },
  } as unknown as M23WriteRouteService;
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMacCredentialRoutes(app, {
    readService: {} as M23ReadRouteService,
    writeService,
    ...(store
      ? {
          testRateLimit: createRouteRateLimit({
            store,
            limit: { ...MAC_CREDENTIAL_TEST_ROUTE_RATE_LIMIT, perUser },
            keyPrefix: "test-mac-test",
          }),
        }
      : {}),
  });
  return { app, probes };
}

let seq = 0;
const post = (app: ReturnType<typeof makeServer>["app"]) =>
  app.inject({
    method: "POST",
    url: URL,
    headers: { "x-test-user": "admin", "idempotency-key": `mac-test-${++seq}` },
    payload: {},
  });

beforeEach(() => {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: USER,
        grants: [
          {
            roleKey: "org_admin",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["billing.mac_credential.admin"],
          },
        ],
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

describe("POST .../mac-credentials/:providerEntityId/test is rate limited and fails closed", () => {
  it("is a fail-closed cap per user and per organization", () => {
    expect(MAC_CREDENTIAL_TEST_ROUTE_RATE_LIMIT.failMode).toBe("closed");
    expect(MAC_CREDENTIAL_TEST_ROUTE_RATE_LIMIT.perUser).toBeLessThanOrEqual(10);
    expect(MAC_CREDENTIAL_TEST_ROUTE_RATE_LIMIT.perOrg).toBeLessThanOrEqual(60);
  });

  it("answers 429 past the per-user cap and calls the gateway only for the requests it let through", async () => {
    const { app, probes } = makeServer(createInMemoryRateLimitStore(), 2);
    expect((await post(app)).statusCode).toBe(200);
    expect((await post(app)).statusCode).toBe(200);
    const limited = await post(app);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(probes).toHaveLength(2);
    await app.close();
  });

  it("answers a typed 503 DEGRADED when the limiter's store is down, and never calls the gateway", async () => {
    const down: RateLimitStore = {
      increment: async () => {
        throw new Error("valkey unreachable");
      },
    };
    const { app, probes } = makeServer(down);
    const res = await post(app);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "DEGRADED" } });
    expect(probes).toEqual([]);
    await app.close();
  });
});
