// M34 — platform DoseSpot registration routes (`/api/v1/platform/tenants/:orgSlug/dosespot…`, tenant onboarding slice 4): the
// guard stack through the REAL guards (permission, `tenant_lifecycle_platform_ops`, step-up, AI-actor block, Idempotency-Key,
// reason), the body contracts, and the plumbing to the service (operator and slug from the session and path, never the body;
// the reason split off the body). The live suite (m12-tenant-dosespot.live.test.ts) proves the same behaviour on the real roles.
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
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import {
  DOSESPOT_VERIFY_ROUTE_RATE_LIMIT,
  createRouteRateLimit,
} from "../src/bootstrap/plugins/route-rate-limit";
import {
  type OnboardingDataService,
  type OnboardingOperator,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";

const PLATFORM_ORG = "11111111-1111-4111-8111-111111111111";
const TARGET_ORG = "22222222-2222-4222-8222-222222222222";
const OPERATOR_USER = "ops-user";
const MEMBERSHIP = "30000000-0000-4000-8000-000000000001";
const PRESCRIBER = "40000000-0000-4000-8000-000000000009";
const REASON = "Customer asked support to register their DoseSpot clinic, ticket CHG-7781";
const SECRET = "fake-clinic-key-not-a-secret#9";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
  const kind = request.headers["x-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

interface Call {
  readonly method: string;
  readonly op: OnboardingOperator;
  readonly orgSlug: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly membershipId?: string;
  readonly expectedVersion?: number | undefined;
}

function recordingService(calls: Call[]): OnboardingDataService {
  const rec =
    (method: string, ret: unknown) =>
    async (op: OnboardingOperator, orgSlug: string, ...rest: unknown[]) => {
      calls.push({
        method,
        op,
        orgSlug,
        reason: rest.find((r) => typeof r === "string") as string | undefined,
      });
      return ret;
    };
  return {
    getDoseSpot: rec("getDoseSpot", { status: "registered", hasSecret: true }),
    putDoseSpot: async (
      op: OnboardingOperator,
      orgSlug: string,
      fields: Record<string, unknown>,
      reason: string,
      expectedVersion: number | undefined,
    ) => {
      calls.push({ method: "putDoseSpot", op, orgSlug, fields, reason, expectedVersion });
      return { created: expectedVersion === undefined, view: { status: "registered" } };
    },
    verifyDoseSpot: rec("verifyDoseSpot", {
      config: { status: "verified" },
      test: { outcome: "ok" },
    }),
    activateDoseSpot: rec("activateDoseSpot", { status: "active" }),
    deactivateDoseSpot: rec("deactivateDoseSpot", { status: "verified" }),
    listDoseSpotPrescribers: rec("listDoseSpotPrescribers", { items: [] }),
    enrollDoseSpotPrescriber: async (
      op: OnboardingOperator,
      orgSlug: string,
      membershipId: string,
      fields: Record<string, unknown>,
      reason: string,
    ) => {
      calls.push({ method: "enrollDoseSpotPrescriber", op, orgSlug, membershipId, fields, reason });
      return { membershipId, enrolledWithDoseSpot: true };
    },
  } as unknown as OnboardingDataService;
}

const keysFor = (...keys: string[]) => ({
  orgId: PLATFORM_ORG,
  grants: [{ roleKey: "platform_ops", enabled: true, expiresAt: null, permissionKeys: keys }],
});

function makeServer(calls: Call[], opts: { verifyLimit?: number } = {}) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        ...keysFor("tenant_dosespot.read_platform", "tenant_dosespot.write_platform"),
        userId: OPERATOR_USER,
      },
      // reads but cannot write
      { ...keysFor("tenant_dosespot.read_platform"), userId: "reader-only" },
      // holds the CLEARINGHOUSE keys, not the DoseSpot ones
      {
        ...keysFor("tenant_clearinghouse.read_platform", "tenant_clearinghouse.write_platform"),
        userId: "clearinghouse-only",
      },
      // a platform role that is NOT platform_ops: holds the keys, fails the predicate
      {
        ...keysFor("tenant_dosespot.read_platform", "tenant_dosespot.write_platform"),
        userId: "support-user",
      },
      { orgId: TARGET_ORG, userId: "tenant-admin", grants: [] },
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
  reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountTenantPlatformRoutes(app, {} as DbClient, {
    onboardingData: {
      service: recordingService(calls),
      ...(opts.verifyLimit
        ? {
            dosespotVerifyRateLimit: createRouteRateLimit({
              store: createInMemoryRateLimitStore(),
              limit: { ...DOSESPOT_VERIFY_ROUTE_RATE_LIMIT, perUser: opts.verifyLimit },
              keyPrefix: "test-m34-ds-verify",
            }) as never,
          }
        : {}),
    },
  });
  return app;
}

const OPS = {
  "x-test-user": OPERATOR_USER,
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
};
let keySeq = 0;
const key = (): string => `k-${++keySeq}`;
const fresh = (): Record<string, string> => ({
  ...OPS,
  "x-step-up": "fresh",
  "idempotency-key": key(),
});
const BASE = "/api/v1/platform/tenants/tenant-b/dosespot";
const PUT_BODY = {
  environment: "sandbox",
  clinicId: "clinic-1",
  serviceClinicianId: "900",
  clinicKey: SECRET,
  reason: REASON,
};
const ENROLL = `${BASE}/prescribers/${PRESCRIBER}/enroll`;
const ENROLL_BODY = { npi: "1234567893", firstName: "Ada", lastName: "Lovelace", reason: REASON };

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

describe("platform DoseSpot write guards", () => {
  const WRITES = [
    { method: "PUT", url: BASE, payload: PUT_BODY },
    { method: "POST", url: `${BASE}/verify`, payload: { reason: REASON } },
    { method: "POST", url: `${BASE}/activate`, payload: { reason: REASON } },
    { method: "POST", url: `${BASE}/deactivate`, payload: { reason: REASON } },
    { method: "POST", url: ENROLL, payload: ENROLL_BODY },
  ] as const;

  for (const w of WRITES) {
    it(`${w.method} ${w.url.replace(PRESCRIBER, ":id")}: refuses no session, a tenant admin, other keys, a non-platform_ops role, a stale step-up, an AI actor, a missing key and a missing reason`, async () => {
      const calls: Call[] = [];
      const app = makeServer(calls);
      const send = (headers: Record<string, string>, payload: object = w.payload) =>
        app.inject({ method: w.method, url: w.url, headers, payload });
      expect((await send({ "idempotency-key": key() })).statusCode).toBe(401);
      expect(
        (
          await send({
            "x-test-user": "tenant-admin",
            "x-test-org": TARGET_ORG,
            "x-test-roles": "org_admin",
            "x-step-up": "fresh",
            "idempotency-key": key(),
          })
        ).statusCode,
      ).toBe(403);
      expect((await send({ ...fresh(), "x-test-user": "reader-only" })).statusCode).toBe(403);
      expect((await send({ ...fresh(), "x-test-user": "clearinghouse-only" })).statusCode).toBe(
        403,
      );
      expect(
        (
          await send({
            ...fresh(),
            "x-test-user": "support-user",
            "x-test-roles": "platform_admin",
          })
        ).statusCode,
      ).toBe(403);
      const stale = await send({ ...OPS, "idempotency-key": key() });
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error?.code ?? stale.json().code).toBe("STEP_UP_REQUIRED");
      expect((await send({ ...fresh(), "x-actor-kind": "ai_agent" })).statusCode).toBe(403);
      const noKey = await send({ ...OPS, "x-step-up": "fresh" });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json().error?.code ?? noKey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const { reason: _r, ...noReason } = w.payload as Record<string, unknown>;
      expect((await send(fresh(), noReason)).statusCode).toBe(422);
      expect((await send(fresh(), { ...w.payload, reason: "short" })).statusCode).toBe(422);
      expect(calls).toEqual([]);
      await app.close();
    });
  }
});

describe("platform DoseSpot reads", () => {
  it("need the read key and the platform_ops predicate; a tenant admin and the clearinghouse keys are refused", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    for (const url of [BASE, `${BASE}/prescribers`]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: {
              "x-test-user": "clearinghouse-only",
              "x-test-org": PLATFORM_ORG,
              "x-test-roles": "platform_ops",
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: { ...OPS, "x-test-user": "support-user", "x-test-roles": "platform_admin" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: { ...OPS, "x-test-user": "reader-only" },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(calls.map((c) => c.method)).toEqual(["getDoseSpot", "listDoseSpotPrescribers"]);
    expect(calls[0]?.orgSlug).toBe("tenant-b");
    await app.close();
  });
});

describe("platform DoseSpot plumbing", () => {
  it("PUT: 201 on a first save, 200 on a change; the reason is split off, the slug is the path's, the operator the session's", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const first = await app.inject({
      method: "PUT",
      url: BASE,
      headers: fresh(),
      payload: PUT_BODY,
    });
    expect(first.statusCode).toBe(201);
    const change = await app.inject({
      method: "PUT",
      url: BASE,
      headers: { ...fresh(), "if-match": '"3"' },
      payload: PUT_BODY,
    });
    expect(change.statusCode).toBe(200);
    expect(calls.map((c) => c.expectedVersion)).toEqual([undefined, 3]);
    expect(calls[0]).toMatchObject({
      orgSlug: "tenant-b",
      reason: REASON,
      op: { userId: OPERATOR_USER, membershipId: MEMBERSHIP },
    });
    expect(calls[0]?.fields).toEqual({
      environment: "sandbox",
      clinicId: "clinic-1",
      serviceClinicianId: "900",
      clinicKey: SECRET,
    });
    expect(first.body).not.toContain(SECRET);
    await app.close();
  });

  it("refuses an unknown environment, a URL, an organization id, an EPCS flag and a short key before the service runs", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const put = (payload: object) =>
      app.inject({ method: "PUT", url: BASE, headers: fresh(), payload });
    for (const bad of [
      { ...PUT_BODY, environment: "staging" },
      { ...PUT_BODY, baseUrl: "https://evil.example.com" },
      { ...PUT_BODY, organizationId: "x" },
      { ...PUT_BODY, epcsCertified: true },
      { ...PUT_BODY, clinicKey: "short" },
    ]) {
      expect((await put(bad)).statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("verify, activate, deactivate and enrol reach the service with the reason; the prescriber id is a uuid", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (url: string, payload: object) =>
      app.inject({ method: "POST", url, headers: fresh(), payload });
    expect((await post(`${BASE}/verify`, { reason: REASON })).json()).toMatchObject({
      test: { outcome: "ok" },
    });
    expect((await post(`${BASE}/activate`, { reason: REASON })).json()).toMatchObject({
      status: "active",
    });
    expect((await post(`${BASE}/deactivate`, { reason: REASON })).json()).toMatchObject({
      status: "verified",
    });
    const enrol = await post(ENROLL, ENROLL_BODY);
    expect(enrol.json()).toEqual({ membershipId: PRESCRIBER, enrolledWithDoseSpot: true });
    expect((await post(`${BASE}/prescribers/not-a-uuid/enroll`, ENROLL_BODY)).statusCode).toBe(422);
    expect((await post(ENROLL, { ...ENROLL_BODY, npi: "123" })).statusCode).toBe(422);
    expect((await post(ENROLL, { ...ENROLL_BODY, epcsRequested: true })).statusCode).toBe(422);
    expect(calls.map((c) => c.method)).toEqual([
      "verifyDoseSpot",
      "activateDoseSpot",
      "deactivateDoseSpot",
      "enrollDoseSpotPrescriber",
    ]);
    expect(calls[3]).toMatchObject({
      membershipId: PRESCRIBER,
      fields: { npi: "1234567893", firstName: "Ada", lastName: "Lovelace" },
    });
    await app.close();
  });

  it("rate limits verify per user, after the guards (an operator who may not verify never spends the budget)", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls, { verifyLimit: 2 });
    const verify = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: `${BASE}/verify`, headers, payload: { reason: REASON } });
    for (let i = 0; i < 5; i += 1) {
      expect((await verify({ ...fresh(), "x-test-user": "reader-only" })).statusCode).toBe(403);
    }
    expect((await verify(fresh())).statusCode).toBe(200);
    expect((await verify(fresh())).statusCode).toBe(200);
    expect((await verify(fresh())).statusCode).toBe(429);
    expect(calls.filter((c) => c.method === "verifyDoseSpot")).toHaveLength(2);
    await app.close();
  });
});
