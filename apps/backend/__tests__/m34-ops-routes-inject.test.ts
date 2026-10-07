// GAP-164 - the six M34 routes added after the first build, driven through the REAL guards (RBAC, the
// `tenant_lifecycle_platform_ops` / `feature_flag_write_authority` predicates, step-up) over the in-memory services:
//   GET /platform/dsar-export-jobs, GET + POST(skip) /platform/tenants/:orgSlug/onboarding,
//   GET /tenant/account, GET /tenant/feature-flags, POST /tenant/feature-flags/:flagKey.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type TenantPlatformAbacResolver,
  buildTenantPlatformAbacPredicates,
  createInMemoryPlatformOpsService,
  createInMemoryTenantAccountFlagsService,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TASK_PENDING = "70000000-0000-4000-8000-000000000001";
const TASK_DONE = "70000000-0000-4000-8000-000000000002";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = "30000000-0000-4000-8000-000000000001";
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

const flagRow = (over: Record<string, unknown>) => ({
  id: "f",
  flagKey: "k",
  organizationId: null as string | null,
  flagKind: "product",
  valueType: "boolean",
  value: false,
  rolloutPercent: null,
  killSwitchActive: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const FLAGS = [
  flagRow({ id: "1", flagKey: "portal.beta", organizationId: null }),
  flagRow({ id: "2", flagKey: "portal.beta", organizationId: ORG, value: false }),
  flagRow({ id: "3", flagKey: "platform.only", organizationId: null }),
  flagRow({ id: "4", flagKey: "emergency", organizationId: ORG, killSwitchActive: true }),
  flagRow({ id: "5", flagKey: "migration.flag", organizationId: ORG, flagKind: "migration" }),
  flagRow({ id: "6", flagKey: "portal.beta", organizationId: OTHER_ORG, value: true }),
];

function makeServer() {
  const ops = createInMemoryPlatformOpsService({
    dsarJobs: [
      {
        id: "d1",
        organizationId: ORG,
        orgSlug: "acme",
        status: "requested",
        requestSource: "patient_request",
        requestedAt: "2026-09-01T00:00:00.000Z",
        slaDueAt: "2026-10-01T00:00:00.000Z",
        extendedUntil: null,
        fulfilledAt: null,
        slaBreached: true,
      },
      {
        id: "d2",
        organizationId: ORG,
        orgSlug: "acme",
        status: "fulfilled",
        requestSource: "patient_request",
        requestedAt: "2026-09-15T00:00:00.000Z",
        slaDueAt: "2026-10-15T00:00:00.000Z",
        extendedUntil: null,
        fulfilledAt: "2026-09-20T00:00:00.000Z",
        slaBreached: false,
      },
    ],
    onboarding: [
      {
        tenantAccountId: "t1",
        orgSlug: "acme",
        tenantStatus: "onboarding",
        currentStep: null,
        tasks: [
          {
            id: TASK_PENDING,
            templateKey: "org_seeded",
            status: "pending",
            isCanonical: true,
            canonicalOrder: 1,
            dueAt: null,
            startedAt: null,
            completedAt: null,
            blockerReason: null,
            skipRationale: null,
          },
          {
            id: TASK_DONE,
            templateKey: "ccn_registered",
            status: "done",
            isCanonical: true,
            canonicalOrder: 2,
            dueAt: null,
            startedAt: null,
            completedAt: null,
            blockerReason: null,
            skipRationale: null,
          },
        ],
      },
    ],
  });
  const tenantFlags = createInMemoryTenantAccountFlagsService({
    accounts: [
      {
        tenantAccountId: "t1",
        organizationId: ORG,
        status: "active",
        planLabel: "standard",
        legalBusinessName: "Acme Hospice",
        dbaName: null,
        billingContactEmail: "b@acme.test",
        breachNotificationEmail: "p@acme.test",
        provisionedAt: null,
        activatedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    flags: FLAGS,
  });

  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "ops",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [
              "dsar_export.list_platform",
              "onboarding.read_platform",
              "onboarding.skip",
            ],
          },
        ],
      },
      {
        orgId: ORG,
        userId: "admin",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [
              "tenant.read_own",
              "feature_flag.read_own",
              "feature_flag.write_tenant",
            ],
          },
        ],
      },
    ]).store,
  );
  const resolver: TenantPlatformAbacResolver = {
    async hasActiveConsentedSupportSession() {
      return false;
    },
    async loadConsentGrant() {
      return null;
    },
    async loadFeatureFlag(_org, flagKey, scope = null) {
      return {
        flagKey,
        organizationId: scope,
        exists: FLAGS.some((f) => f.flagKey === flagKey && f.organizationId === scope),
      };
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
  mountTenantPlatformRoutes(app, {} as DbClient, {
    platformOps: { service: ops.service },
    tenantAccountFlags: { service: tenantFlags },
  });
  return { app, ops };
}

const OPS = { "x-test-user": "ops", "x-test-org": ORG, "x-test-roles": "platform_ops" };
const ADMIN = { "x-test-user": "admin", "x-test-org": ORG, "x-test-roles": "org_admin" };

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

describe("GET /platform/dsar-export-jobs", () => {
  it("lists jobs for platform ops, filters by SLA, and never carries a patient id", async () => {
    const { app } = makeServer();
    const all = await app.inject({
      method: "GET",
      url: "/api/v1/platform/dsar-export-jobs",
      headers: OPS,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toHaveLength(2);
    expect(JSON.stringify(all.json())).not.toContain("patientId");
    const breached = await app.inject({
      method: "GET",
      url: "/api/v1/platform/dsar-export-jobs?slaBreached=true",
      headers: OPS,
    });
    expect(breached.json().items.map((j: { id: string }) => j.id)).toEqual(["d1"]);
    await app.close();
  });

  it("denies a tenant org_admin (permission-less and not platform ops) and an anonymous caller", async () => {
    const { app } = makeServer();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/platform/dsar-export-jobs",
          headers: ADMIN,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/platform/dsar-export-jobs" })).statusCode,
    ).toBe(401);
    await app.close();
  });
});

describe("platform onboarding read + skip", () => {
  it("reads the task list with the current step", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants/acme/onboarding",
      headers: OPS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentStep).toBe("org_seeded");
    expect(res.json().tasks).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/platform/tenants/nope/onboarding",
          headers: OPS,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("skip needs step-up and a rationale, records the actor, and refuses a settled task", async () => {
    const { app, ops } = makeServer();
    const url = `/api/v1/platform/tenants/acme/onboarding/${TASK_PENDING}/skip`;
    const payload = { skipRationale: "tenant migrating from another system" };
    expect((await app.inject({ method: "POST", url, headers: OPS, payload })).statusCode).toBe(403);
    const stepped = { ...OPS, "x-step-up": "fresh" };
    expect(
      (await app.inject({ method: "POST", url, headers: stepped, payload: { skipRationale: "x" } }))
        .statusCode,
    ).toBe(422);
    const ok = await app.inject({ method: "POST", url, headers: stepped, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("skipped");
    expect(ops.skips).toHaveLength(1);
    const again = await app.inject({ method: "POST", url, headers: stepped, payload });
    expect(again.statusCode).toBe(409);
    const doneUrl = `/api/v1/platform/tenants/acme/onboarding/${TASK_DONE}/skip`;
    expect(
      (await app.inject({ method: "POST", url: doneUrl, headers: stepped, payload })).statusCode,
    ).toBe(409);
    await app.close();
  });

  it("denies a tenant org_admin the skip", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/platform/tenants/acme/onboarding/${TASK_PENDING}/skip`,
      headers: { ...ADMIN, "x-step-up": "fresh" },
      payload: { skipRationale: "tenant migrating from another system" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("tenant account + feature flags", () => {
  it("reads the tenant's own account only", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/tenant/account", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json().legalBusinessName).toBe("Acme Hospice");
    await app.close();
  });

  it("lists effective flags: own row overrides global, another tenant's row never appears", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/feature-flags",
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as {
      flagKey: string;
      scope: string;
      value: unknown;
      tenantToggleable: boolean;
    }[];
    const beta = items.find((i) => i.flagKey === "portal.beta");
    expect(beta).toMatchObject({ scope: "tenant", value: false, tenantToggleable: true });
    expect(items.find((i) => i.flagKey === "platform.only")).toMatchObject({
      scope: "platform",
      tenantToggleable: false,
    });
    expect(items.find((i) => i.flagKey === "emergency")?.tenantToggleable).toBe(false);
    expect(items.find((i) => i.flagKey === "migration.flag")?.tenantToggleable).toBe(false);
    await app.close();
  });

  it("toggles an own boolean product flag with step-up and persists it", async () => {
    const { app } = makeServer();
    const url = "/api/v1/tenant/feature-flags/portal.beta";
    expect(
      (await app.inject({ method: "POST", url, headers: ADMIN, payload: { enabled: true } }))
        .statusCode,
    ).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { ...ADMIN, "x-step-up": "fresh" },
      payload: { enabled: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ flagKey: "portal.beta", value: true, scope: "tenant" });
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/feature-flags",
      headers: ADMIN,
    });
    expect(
      after.json().items.find((i: { flagKey: string }) => i.flagKey === "portal.beta").value,
    ).toBe(true);
    await app.close();
  });

  it("refuses a global-only flag, a kill-switched flag, a migration flag and an unknown flag", async () => {
    const { app } = makeServer();
    const headers = { ...ADMIN, "x-step-up": "fresh" };
    for (const key of ["platform.only", "emergency", "migration.flag"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tenant/feature-flags/${key}`,
        headers,
        payload: { enabled: true },
      });
      expect([403]).toContain(res.statusCode);
    }
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/tenant/feature-flags/ghost",
      headers,
      payload: { enabled: true },
    });
    expect(unknown.statusCode).toBe(403);
    await app.close();
  });
});
