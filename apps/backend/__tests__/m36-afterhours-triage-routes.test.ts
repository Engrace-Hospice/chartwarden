// ADR-0082 - the after-hours triage line read: the route budget is APPLIED (not merely accepted), after authorisation and before
// the service, and the composition root threads it through mountMessagingRoutes -> registerMessagingRoutes -> the route.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requireAbac,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { RateLimitedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { AfterHoursLinesService } from "../src/modules/36-messaging/afterhours-triage/afterhours-lines";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { registerAfterHoursTriageRoutes } from "../src/modules/36-messaging/routes/afterhours-triage-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const ROUTE = `/api/v1/messaging/channels/${CH}/afterhours-triage?message_ids=${MSG}`;

const resetAuth = () => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
};
beforeEach(resetAuth);
afterEach(resetAuth);

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer(rateLimit: Handler | undefined, service: AfterHoursLinesService) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "nurse",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["messaging.read"] },
        ],
      },
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (_ctx, target) => target.id === CH);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAfterHoursTriageRoutes(
    app,
    { service, ...(rateLimit ? { rateLimit } : {}) },
    {
      read: requirePermission("messaging.read") as Handler,
      viewChannel: requireAbac("messaging.read", CHANNEL_VISIBILITY_PREDICATE) as Handler,
    },
  );
  return app;
}

const get = (app: ReturnType<typeof makeServer>, user: string | null) =>
  app.inject({ method: "GET", url: ROUTE, headers: user ? { "x-test-user": user } : {} });

const okService = (): AfterHoursLinesService => ({
  forChannel: async () => ({ lines: [] }) as never,
});

describe("GET /api/v1/messaging/channels/:id/afterhours-triage rate limit", () => {
  it("answers 429 from the limiter, after authorisation and before the service", async () => {
    let limited = 0;
    let served = 0;
    const app = makeServer(
      async () => {
        limited += 1;
        throw new RateLimitedError();
      },
      {
        forChannel: async () => {
          served += 1;
          return { lines: [] } as never;
        },
      },
    );
    expect((await get(app, "nurse")).statusCode).toBe(429);
    expect(limited).toBe(1);
    expect(served).toBe(0);
    // an unauthenticated caller is refused before the limiter spends any budget
    expect((await get(app, null)).statusCode).toBe(401);
    expect(limited).toBe(1);
    await app.close();
  });

  it("serves when the limiter lets the request through", async () => {
    let seen = 0;
    const app = makeServer(async () => void (seen += 1), okService());
    expect((await get(app, "nurse")).statusCode).toBe(200);
    expect(seen).toBe(1);
    await app.close();
  });

  it("serves when no limiter is configured", async () => {
    const app = makeServer(undefined, okService());
    expect((await get(app, "nurse")).statusCode).toBe(200);
    await app.close();
  });
});

describe("afterHoursTriageRateLimit wiring", () => {
  const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

  it("mountMessagingRoutes forwards it to registerMessagingRoutes, which hands it to the route", () => {
    expect(read("../src/modules/36-messaging/index.ts")).toMatch(
      /opts\.afterHoursTriageRateLimit \? \{ afterHoursTriageRateLimit: opts\.afterHoursTriageRateLimit \}/,
    );
    expect(read("../src/modules/36-messaging/routes/messaging-routes.ts")).toMatch(
      /afterHoursLines, rateLimit: deps\.afterHoursTriageRateLimit/,
    );
  });

  it("the composition root builds it from the dedicated budget and mounts it", () => {
    expect(read("../src/index.ts")).toMatch(
      /afterHoursTriageRateLimit: createRouteRateLimit\(\{[^}]*limit: AFTERHOURS_TRIAGE_LINES_ROUTE_RATE_LIMIT/s,
    );
  });
});
