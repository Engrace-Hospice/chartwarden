// Slice 7 (7S) - the platform support-session routes and the ledger hook, driven through the REAL guard chains (RBAC, the D16
// distinct-actor predicate, step-up) over the in-memory platform service:
//   * start records the session in the organization of the consent GRANT, never the operator's own;
//   * elevate on an `assist` session is refused 403 SUPPORT_SESSION_NON_PHI;
//   * the manual close answers `manual` and is repeatable;
//   * the `onResponse` ledger hook appends ONE `ops.write` per successful non-GET on /platform/tenants/:orgSlug/*, and nothing for
//     a read, a failure or another prefix; a recorder that throws never turns the success into an error, and the log line carries
//     ids only.
// The services' rules over Postgres and RLS are proven by m34-support-session.live.test.ts.
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
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type SupportLedgerWrite,
  type TenantPlatformAbacResolver,
  buildTenantPlatformAbacPredicates,
  createInMemoryTenantPlatformBackend,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";

const PLATFORM_ORG = "99999999-9999-4999-8999-999999999999";
const TENANT_ORG = "11111111-1111-4111-8111-111111111111";
const TENANT_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const GRANTOR = "30000000-0000-4000-8000-000000000009";
const OPERATOR = "30000000-0000-4000-8000-0000000000a1";
const PHI_GRANT = "70000000-0000-4000-8000-0000000000c1";
const ASSIST_GRANT = "70000000-0000-4000-8000-0000000000c2";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = request.headers["x-test-membership"] ?? OPERATOR;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

const OPS = { "x-test-user": "ops", "x-test-org": PLATFORM_ORG, "x-test-roles": "platform_ops" };
const NO_KEYS = {
  "x-test-user": "nokeys",
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
};
const FRESH = { "x-step-up": "fresh" };
const OPS_KEYS = [
  "support_session.list_platform",
  "support_session.start",
  "support_session.close",
  "support_session.elevate_phi_read",
];

interface Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly recorded: SupportLedgerWrite[];
  readonly warnings: { message: string; context: Record<string, unknown> }[];
  readonly routes: string[];
  readonly send: (
    method: "GET" | "POST" | "PUT",
    url: string,
    headers?: Record<string, string>,
    payload?: Record<string, unknown>,
  ) => Promise<{ statusCode: number; json: () => any }>;
}

function makeServer(opts: { recorderThrows?: boolean } = {}): Harness {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: PLATFORM_ORG,
        userId: "ops",
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: OPS_KEYS }],
      },
      {
        orgId: PLATFORM_ORG,
        userId: "nokeys",
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
      },
    ]).store,
  );
  const grants = new Map([
    [PHI_GRANT, { grantorMembershipId: GRANTOR }],
    [ASSIST_GRANT, { grantorMembershipId: GRANTOR }],
  ]);
  const resolver: TenantPlatformAbacResolver = {
    // the elevation predicate: an active consented session exists (the service's own refusal is what this suite reaches)
    async hasActiveConsentedSupportSession() {
      return true;
    },
    async loadConsentGrant(_org, grantId) {
      const g = grants.get(grantId);
      return g
        ? {
            grantId,
            tenantAccountId: TENANT_ACCOUNT,
            grantorMembershipId: g.grantorMembershipId,
            active: true,
          }
        : null;
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
  // Stands in for the idempotency plugin's `preHandler`: a replay is answered from a cache before any handler runs.
  app.addHook("preHandler", async (request, reply) => {
    if (request.headers["x-replay"] === "1")
      return reply.code(200).send({ ok: true, replay: true });
  });
  const routes: string[] = [];
  app.addHook("onRoute", (route) => {
    routes.push(`${[route.method].flat().join(",")} ${route.url}`);
  });
  const recorded: SupportLedgerWrite[] = [];
  const warnings: Harness["warnings"] = [];
  mountTenantPlatformRoutes(app, {} as DbClient, {
    platform: createInMemoryTenantPlatformBackend({
      consentGrants: [
        {
          id: PHI_GRANT,
          organizationId: TENANT_ORG,
          tenantAccountId: TENANT_ACCOUNT,
          grantorMembershipId: GRANTOR,
          expiresAt: FAR_FUTURE,
          scope: "organization_scoped",
        },
        {
          id: ASSIST_GRANT,
          organizationId: TENANT_ORG,
          tenantAccountId: TENANT_ACCOUNT,
          grantorMembershipId: GRANTOR,
          expiresAt: FAR_FUTURE,
          scope: "assist",
        },
      ],
    }),
    supportLedger: {
      recorder: {
        async recordOpsWrite(write) {
          if (opts.recorderThrows)
            throw new Error("patient Jane Doe SSN 000-00-0000 leaked in an error");
          recorded.push(write);
        },
      },
      warn: (message, context) => warnings.push({ message, context }),
    },
  });
  // A probe under the covered prefix, so the hook is exercised on a route with no other dependency.
  app.post("/api/v1/platform/tenants/:orgSlug/ledger-probe", async (request, reply) => {
    const outcome = (request.body as { outcome?: string } | undefined)?.outcome;
    return reply
      .code(outcome === "fail" ? 409 : outcome === "created" ? 201 : 200)
      .send({ ok: outcome !== "fail" });
  });
  app.get("/api/v1/platform/tenants/:orgSlug/ledger-probe", async () => ({ ok: true }));
  app.put("/api/v1/platform/other/:orgSlug/ledger-probe", async () => ({ ok: true }));
  return {
    app,
    recorded,
    warnings,
    routes,
    send: (method, url, headers, payload) =>
      app.inject({ method, url, headers: headers ?? {}, payload }) as never,
  };
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

describe("POST /platform/support-sessions - start", () => {
  const start = (grantId: string) => ({ supportConsentGrantId: grantId });

  it("records the session in the organization of the GRANT, not the operator's own", async () => {
    const { app, send } = makeServer();
    const res = await send(
      "POST",
      "/api/v1/platform/support-sessions",
      { ...OPS, ...FRESH, "idempotency-key": "start-org" },
      start(PHI_GRANT),
    );
    expect(res.statusCode).toBe(201);
    const listed = await send("GET", "/api/v1/platform/support-sessions", OPS);
    const session = (listed.json() as { items: { id: string; organizationId: string }[] }).items[0];
    expect(session?.organizationId).toBe(TENANT_ORG);
    expect(session?.organizationId).not.toBe(PLATFORM_ORG);
    await app.close();
  });

  it("needs the start key and a fresh step-up, and refuses the grantor's own membership (D16)", async () => {
    const { app, send } = makeServer();
    const url = "/api/v1/platform/support-sessions";
    expect((await send("POST", url, { ...NO_KEYS, ...FRESH }, start(PHI_GRANT))).statusCode).toBe(
      403,
    );
    const noStepUp = await send(
      "POST",
      url,
      { ...OPS, "idempotency-key": "start-no-step-up" },
      start(PHI_GRANT),
    );
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe("STEP_UP_REQUIRED");
    const self = await send(
      "POST",
      url,
      {
        ...OPS,
        ...FRESH,
        "x-test-membership": GRANTOR,
        "idempotency-key": "start-self",
      },
      start(PHI_GRANT),
    );
    expect(self.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /platform/support-sessions/:id/elevate", () => {
  it("is refused 403 SUPPORT_SESSION_NON_PHI on a session of an assist grant", async () => {
    const { app, send } = makeServer();
    const started = await send(
      "POST",
      "/api/v1/platform/support-sessions",
      { ...OPS, ...FRESH, "idempotency-key": "start-assist" },
      {
        supportConsentGrantId: ASSIST_GRANT,
      },
    );
    const { sessionId } = started.json() as { sessionId: string };
    const res = await send(
      "POST",
      `/api/v1/platform/support-sessions/${sessionId}/elevate?tenantAccountId=${TENANT_ACCOUNT}`,
      { ...OPS, ...FRESH, "idempotency-key": "elevate-assist" },
      {},
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SUPPORT_SESSION_NON_PHI");
    await app.close();
  });
});

describe("POST /platform/support-sessions/:id/close", () => {
  it("answers `manual`, closes the session, and can be repeated", async () => {
    const { app, send } = makeServer();
    const started = await send(
      "POST",
      "/api/v1/platform/support-sessions",
      { ...OPS, ...FRESH, "idempotency-key": "start-close" },
      {
        supportConsentGrantId: PHI_GRANT,
      },
    );
    const { sessionId } = started.json() as { sessionId: string };
    const url = `/api/v1/platform/support-sessions/${sessionId}/close`;
    expect((await send("POST", url, NO_KEYS, {})).statusCode).toBe(403);
    const closed = await send("POST", url, { ...OPS, "idempotency-key": "close-1" }, {});
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ sessionId, closeReason: "manual" });
    const listed = await send("GET", "/api/v1/platform/support-sessions?status=closed", OPS);
    expect((listed.json() as { items: { closeReason: string }[] }).items[0]?.closeReason).toBe(
      "manual",
    );
    expect((await send("POST", url, { ...OPS, "idempotency-key": "close-2" }, {})).statusCode).toBe(
      200,
    );
    await app.close();
  });
});

describe("the support ledger hook", () => {
  const probe = "/api/v1/platform/tenants/acme-hospice/ledger-probe";

  it("appends one ops.write per successful non-GET: the route TEMPLATE, method and status, never the slug or the body", async () => {
    const { app, send, recorded } = makeServer();
    const body = { outcome: "created", note: "patient Jane Doe" };
    expect((await send("POST", probe, OPS, body)).statusCode).toBe(201);
    expect((await send("POST", probe, OPS, { outcome: "ok" })).statusCode).toBe(200);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({
      actorMembershipId: OPERATOR,
      orgSlug: "acme-hospice",
      route: "/api/v1/platform/tenants/:orgSlug/ledger-probe",
      method: "POST",
      status: 201,
      actorIp: expect.any(String),
    });
    expect(recorded[1]?.status).toBe(200);
    expect(JSON.stringify(recorded)).not.toContain("Jane");
    await app.close();
  });

  it("appends nothing for a read, a failure, another prefix or an unauthenticated call", async () => {
    const { app, send, recorded } = makeServer();
    await send("GET", probe, OPS);
    await send("POST", probe, OPS, { outcome: "fail" });
    await send("PUT", "/api/v1/platform/other/acme-hospice/ledger-probe", OPS, {});
    await send("POST", probe, {}, {});
    expect(recorded).toEqual([]);
    await app.close();
  });

  it("does not record an idempotent replay: one row per write, not per response", async () => {
    const { app, send, recorded } = makeServer();
    expect((await send("POST", probe, OPS, { outcome: "ok" })).statusCode).toBe(200);
    expect(
      (await send("POST", probe, { ...OPS, "x-replay": "1" }, { outcome: "ok" })).statusCode,
    ).toBe(200);
    expect(recorded).toHaveLength(1);
    await app.close();
  });

  it("covers the platform lane's real routes: every registered tenant-scoped platform route sits under the hook's prefix", async () => {
    const { app, routes } = makeServer();
    const tenantRoutes = routes.filter((r) => r.includes("/api/v1/platform/tenants/:orgSlug/"));
    expect(tenantRoutes.length).toBeGreaterThanOrEqual(10);
    for (const write of ["/status", "/offboard", "/onboarding/:taskId/skip"]) {
      expect(
        tenantRoutes.some((r) => r.startsWith("POST") && r.endsWith(write)),
        write,
      ).toBe(true);
    }
    await app.close();
  });

  it("never turns a success into an error when the append fails, and logs ids and an error class only", async () => {
    const { app, send, warnings } = makeServer({ recorderThrows: true });
    const res = await send("POST", probe, OPS, { outcome: "ok" });
    expect(res.statusCode).toBe(200);
    // onResponse runs after the reply: let the hook settle
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toEqual({
      actorMembershipId: OPERATOR,
      route: "/api/v1/platform/tenants/:orgSlug/ledger-probe",
      method: "POST",
      status: 200,
      errorClass: "Error",
    });
    expect(JSON.stringify(warnings)).not.toMatch(/Jane|SSN|leaked/);
    await app.close();
  });
});
