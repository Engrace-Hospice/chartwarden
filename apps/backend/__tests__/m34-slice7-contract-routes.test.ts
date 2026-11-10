// Slice 7 wave 0 - the new routes driven through their REAL guard chains (RBAC, the M34 ABAC predicates, step-up, the AI-actor
// block, the Idempotency-Key requirement, the filing rate limit) with the service behind them still the 501 stand-in:
//   tenant:   GET|POST /help-requests, POST /help-requests/:id/approve | close, GET /support-sessions and /:id/events,
//             POST /onboarding/:taskId/skip, and the `assist` scope on POST /support-consent-grants
//   platform: GET /help-requests, POST /help-requests/:id/resolve, GET /support-consent-grants
// Each refusal is proven BEFORE the stub (so a guard that falls off a route turns a 4xx into a 501 and fails here), and each
// accepted request reaches the stub and answers the typed 501 NOT_IMPLEMENTED envelope. The services' rules are their owner
// pieces' (7K, 7S, 7B) and are proven there.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import type { FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import {
  HELP_REQUEST_ROUTE_RATE_LIMIT,
  createRouteRateLimit,
} from "../src/bootstrap/plugins/route-rate-limit";
import {
  type TenantPlatformAbacResolver,
  buildTenantPlatformAbacPredicates,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";

const PLATFORM_ORG = "99999999-9999-4999-8999-999999999999";
const TENANT_ORG = "11111111-1111-4111-8111-111111111111";
const ID = "70000000-0000-4000-8000-000000000001";
// A fresh key per request: the idempotency layer answers 409 IDEMPOTENCY_CONFLICT to one key reused with a different body.
let keyCounter = 0;
const key = () => ({ "idempotency-key": `slice7-contract-key-${++keyCounter}` });

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId =
    request.headers["x-test-membership"] ?? "30000000-0000-4000-8000-000000000001";
  if (request.headers["x-test-no-membership"] === "1")
    request.context.attributes.membershipId = undefined;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
  if (request.headers["x-actor-kind"])
    request.context.attributes.actorKind = request.headers["x-actor-kind"];
}

const ADMIN = { "x-test-user": "admin", "x-test-org": TENANT_ORG, "x-test-roles": "org_admin" };
const MEMBER = { "x-test-user": "member", "x-test-org": TENANT_ORG, "x-test-roles": "nurse" };
const OPS = { "x-test-user": "ops", "x-test-org": PLATFORM_ORG, "x-test-roles": "platform_ops" };
const NOT_OPS = { "x-test-user": "ops2", "x-test-org": PLATFORM_ORG, "x-test-roles": "staff" };
const FRESH = { "x-step-up": "fresh" };
const AI = { "x-actor-kind": "ai_agent" };

const ADMIN_KEYS = [
  "onboarding.manage_own",
  "support_consent_grant.list_own",
  "support_consent_grant.issue",
];
const OPS_KEYS = ["support_session.list_platform", "support_session.close"];

type Headers = Record<string, string>;

function makeServer(opts: { fileRateLimit?: boolean } = {}) {
  const grant = (orgId: string, userId: string, permissionKeys: string[]) => ({
    orgId,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant(TENANT_ORG, "admin", ADMIN_KEYS),
      grant(TENANT_ORG, "member", []),
      grant(PLATFORM_ORG, "ops", OPS_KEYS),
      grant(PLATFORM_ORG, "ops2", OPS_KEYS),
    ]).store,
  );
  const resolver: TenantPlatformAbacResolver = {
    async hasActiveConsentedSupportSession() {
      return false;
    },
    async loadConsentGrant() {
      return null;
    },
    async loadFeatureFlag() {
      return null;
    },
    async loadOnboardingTask() {
      return null;
    },
  };
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildTenantPlatformAbacPredicates({ resolver, isInCaseload: async () => false }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const registered: { method: string | string[]; url: string; config: unknown }[] = [];
  app.addHook("onRoute", (route) => {
    registered.push({ method: route.method, url: route.url, config: route.config });
  });
  mountTenantPlatformRoutes(app, {} as DbClient, {
    help: opts.fileRateLimit
      ? {
          fileRateLimit: createRouteRateLimit({
            store: createInMemoryRateLimitStore(),
            limit: HELP_REQUEST_ROUTE_RATE_LIMIT,
            keyPrefix: "m34-help-request-test",
          }),
        }
      : {},
  });
  const send = (
    method: "GET" | "POST",
    url: string,
    headers: Headers = {},
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> => app.inject({ method, url, headers, payload });
  return { app, send, registered };
}

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

const NOT_BUILT = { statusCode: 501, code: "NOT_IMPLEMENTED" } as const;

async function expectNotBuilt(res: { statusCode: number; json: () => unknown }): Promise<void> {
  expect(res.statusCode).toBe(NOT_BUILT.statusCode);
  const body = res.json() as { error: { code: string; message: string; correlationId: string } };
  expect(body.error.code).toBe(NOT_BUILT.code);
  expect(body.error.correlationId).toEqual(expect.any(String));
}

describe("tenant help requests", () => {
  const url = "/api/v1/tenant/help-requests";
  const message = { message: "We cannot find our MAC enrolment letter" };

  it("GET needs a session with a membership, and nothing else", async () => {
    const { app, send } = makeServer();
    expect((await send("GET", url)).statusCode).toBe(401);
    expect((await send("GET", url, { ...MEMBER, "x-test-no-membership": "1" })).statusCode).toBe(
      403,
    );
    expect((await send("GET", `${url}?limit=0`, MEMBER)).statusCode).toBe(422);
    // A member with no permission key at all reaches the service: any member may read.
    await expectNotBuilt(await send("GET", url, MEMBER));
    await app.close();
  });

  it("POST file: session, AI block, Idempotency-Key and the body, in that order", async () => {
    const { app, send } = makeServer();
    expect((await send("POST", url, key(), message)).statusCode).toBe(401);
    const ai = await send("POST", url, { ...MEMBER, ...AI, ...key() }, message);
    expect(ai.statusCode).toBe(403);
    expect(ai.json().error.message).toContain("AI principals");
    const noKey = await send("POST", url, MEMBER, message);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(
      (await send("POST", url, { ...MEMBER, ...key() }, { message: "short" })).statusCode,
    ).toBe(422);
    expect(
      (await send("POST", url, { ...MEMBER, ...key() }, { stepKey: "", message: "long enough" }))
        .statusCode,
    ).toBe(422);
    await expectNotBuilt(await send("POST", url, { ...MEMBER, ...key() }, message));
    await app.close();
  });

  it("POST file is capped at 3 an hour per member by the production limiter, after the key check", async () => {
    const { app, send } = makeServer({ fileRateLimit: true });
    const headers = { ...MEMBER, ...key() };
    for (let i = 0; i < 3; i += 1) await expectNotBuilt(await send("POST", url, headers, message));
    const limited = await send("POST", url, headers, message);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBe("3600");
    // A request without the key is refused 400 before the limiter counts it.
    expect((await send("POST", url, MEMBER, message)).statusCode).toBe(400);
    await app.close();
  });

  it("POST approve needs the grant-issue key, a fresh step-up, a human and an Idempotency-Key", async () => {
    const { app, send } = makeServer();
    const approve = `${url}/${ID}/approve`;
    expect((await send("POST", approve, { ...MEMBER, ...FRESH, ...key() }, {})).statusCode).toBe(
      403,
    );
    const noStepUp = await send("POST", approve, { ...ADMIN, ...key() }, {});
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
    const stepped = { ...ADMIN, ...FRESH };
    expect((await send("POST", approve, { ...stepped, ...AI, ...key() }, {})).statusCode).toBe(403);
    expect((await send("POST", approve, stepped, {})).statusCode).toBe(400);
    expect(
      (await send("POST", `${url}/not-a-uuid/approve`, { ...stepped, ...key() }, {})).statusCode,
    ).toBe(422);
    for (const hours of [0, 25]) {
      expect((await send("POST", approve, { ...stepped, ...key() }, { hours })).statusCode).toBe(
        422,
      );
    }
    await expectNotBuilt(await send("POST", approve, { ...stepped, ...key() }, { hours: 8 }));
    await expectNotBuilt(await send("POST", approve, { ...stepped, ...key() }, {}));
    await app.close();
  });

  it("POST close needs a session, a human and an Idempotency-Key, and no step-up", async () => {
    const { app, send } = makeServer();
    const close = `${url}/${ID}/close`;
    expect((await send("POST", close, key())).statusCode).toBe(401);
    expect((await send("POST", close, { ...MEMBER, ...AI, ...key() })).statusCode).toBe(403);
    expect((await send("POST", close, MEMBER)).statusCode).toBe(400);
    expect((await send("POST", `${url}/nope/close`, { ...MEMBER, ...key() })).statusCode).toBe(422);
    await expectNotBuilt(await send("POST", close, { ...MEMBER, ...key() }));
    await app.close();
  });
});

describe("tenant support-session reads", () => {
  it("need the support-consent-grant list key and reach the stand-in", async () => {
    const { app, send } = makeServer();
    for (const url of [
      "/api/v1/tenant/support-sessions",
      `/api/v1/tenant/support-sessions/${ID}/events`,
    ]) {
      expect((await send("GET", url)).statusCode).toBe(401);
      expect((await send("GET", url, MEMBER)).statusCode).toBe(403);
      await expectNotBuilt(await send("GET", url, ADMIN));
    }
    expect(
      (await send("GET", "/api/v1/tenant/support-sessions/not-a-uuid/events", ADMIN)).statusCode,
    ).toBe(422);
    await app.close();
  });

  it("accept the assist scope on grant issue, which the stand-in then refuses with the typed 501", async () => {
    const { app, send } = makeServer();
    const body = {
      grantReason: "help request 70000000-0000-4000-8000-000000000001",
      expiresAtIsoOffsetHours: 8,
    };
    const url = "/api/v1/tenant/support-consent-grants";
    expect(
      (await send("POST", url, { ...ADMIN, ...FRESH }, { ...body, scope: "everything" }))
        .statusCode,
    ).toBe(422);
    await expectNotBuilt(
      await send("POST", url, { ...ADMIN, ...FRESH }, { ...body, scope: "assist" }),
    );
    await app.close();
  });
});

describe("tenant skip", () => {
  const skip = `/api/v1/tenant/onboarding/${ID}/skip`;
  const body = { skipRationale: "We bill outside the system" };

  it("is the org_admin's, under a fresh step-up, as a human, once per Idempotency-Key", async () => {
    const { app, send } = makeServer();
    const stepped = { ...ADMIN, ...FRESH };
    expect((await send("POST", skip, { ...stepped, ...key() }, body)).statusCode).toBe(501);
    // No permission key.
    expect((await send("POST", skip, { ...MEMBER, ...FRESH, ...key() }, body)).statusCode).toBe(
      403,
    );
    // The key without the org_admin role: the ABAC predicate refuses.
    const notAdmin = { ...ADMIN, "x-test-roles": "administrator", ...FRESH, ...key() };
    expect((await send("POST", skip, notAdmin, body)).statusCode).toBe(403);
    const noStepUp = await send("POST", skip, { ...ADMIN, ...key() }, body);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
    expect((await send("POST", skip, { ...stepped, ...AI, ...key() }, body)).statusCode).toBe(403);
    expect((await send("POST", skip, stepped, body)).statusCode).toBe(400);
    expect(
      (await send("POST", skip, { ...stepped, ...key() }, { skipRationale: "short" })).statusCode,
    ).toBe(422);
    await app.close();
  });
});

describe("platform help requests", () => {
  const url = "/api/v1/platform/help-requests";

  it("GET is the operators' audited inbox: key, platform_ops ABAC, a valid status filter", async () => {
    const { app, send } = makeServer();
    expect((await send("GET", url)).statusCode).toBe(401);
    expect((await send("GET", url, ADMIN)).statusCode).toBe(403);
    expect((await send("GET", url, NOT_OPS)).statusCode).toBe(403);
    expect((await send("GET", `${url}?status=open,bogus`, OPS)).statusCode).toBe(422);
    await expectNotBuilt(await send("GET", url, OPS));
    await expectNotBuilt(await send("GET", `${url}?status=open,approved&limit=1`, OPS));
    await app.close();
  });

  it("POST resolve needs the close key, platform_ops, a human, an Idempotency-Key and a note", async () => {
    const { app, send } = makeServer();
    const resolve = `${url}/${ID}/resolve`;
    const note = { note: "Walked them through the payer list" };
    expect((await send("POST", resolve, key(), note)).statusCode).toBe(401);
    expect((await send("POST", resolve, { ...ADMIN, ...key() }, note)).statusCode).toBe(403);
    expect((await send("POST", resolve, { ...NOT_OPS, ...key() }, note)).statusCode).toBe(403);
    expect((await send("POST", resolve, { ...OPS, ...AI, ...key() }, note)).statusCode).toBe(403);
    expect((await send("POST", resolve, OPS, note)).statusCode).toBe(400);
    expect((await send("POST", resolve, { ...OPS, ...key() }, { note: "short" })).statusCode).toBe(
      422,
    );
    expect((await send("POST", `${url}/nope/resolve`, { ...OPS, ...key() }, note)).statusCode).toBe(
      422,
    );
    await expectNotBuilt(await send("POST", resolve, { ...OPS, ...key() }, note));
    await app.close();
  });

  it("GET support-consent-grants is an audited platform read behind the same guards", async () => {
    const { app, send } = makeServer();
    const grants = "/api/v1/platform/support-consent-grants";
    expect((await send("GET", grants)).statusCode).toBe(401);
    expect((await send("GET", grants, ADMIN)).statusCode).toBe(403);
    expect((await send("GET", grants, NOT_OPS)).statusCode).toBe(403);
    expect((await send("GET", `${grants}?tenantAccountId=x`, OPS)).statusCode).toBe(422);
    await expectNotBuilt(await send("GET", `${grants}?tenantAccountId=${ID}&active=true`, OPS));
    await app.close();
  });
});

describe("mounting", () => {
  it("registers every slice 7 route, declaring the audited reads and leaving the tenant poll un-audited", async () => {
    const { app, registered } = makeServer();
    const find = (method: string, url: string) =>
      registered.find((r) => [r.method].flat().includes(method) && r.url === url);
    const audited = [
      "/api/v1/tenant/support-sessions",
      "/api/v1/tenant/support-sessions/:id/events",
      "/api/v1/platform/help-requests",
      "/api/v1/platform/support-consent-grants",
    ];
    for (const url of audited) {
      const route = find("GET", url);
      expect(route, url).toBeDefined();
      expect((route?.config as { auditRead?: { list?: boolean } }).auditRead?.list).toBe(true);
    }
    expect(
      ((find("GET", "/api/v1/tenant/help-requests")?.config ?? {}) as { auditRead?: unknown })
        .auditRead,
    ).toBeUndefined();
    for (const [method, url] of [
      ["POST", "/api/v1/tenant/help-requests"],
      ["POST", "/api/v1/tenant/help-requests/:id/approve"],
      ["POST", "/api/v1/tenant/help-requests/:id/close"],
      ["POST", "/api/v1/tenant/onboarding/:taskId/skip"],
      ["POST", "/api/v1/platform/help-requests/:id/resolve"],
    ] as const) {
      expect(find(method, url), `${method} ${url}`).toBeDefined();
    }
    await app.close();
  });
});
