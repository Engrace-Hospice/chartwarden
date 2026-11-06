// M34 — platform onboarding-data routes (`/api/v1/platform/tenants/:orgSlug/{provider-entities,locations,mac-credentials}`):
// the guard stack through the REAL guards (permission, `tenant_lifecycle_platform_ops`, step-up, AI-actor block,
// Idempotency-Key, reason), and the service's status lock + audit row over a stubbed database. The live suite
// (m34-onboarding-data.live.test.ts) proves the same behaviour on the real roles; this one is the fast regression net.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type OnboardingDataService,
  type OnboardingOperator,
  buildDrizzleOnboardingDataService,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import { ONBOARDING_DATA_AUDIT_EVENTS } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-audit";
import { toMemberViews } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-members";

const PLATFORM_ORG = "11111111-1111-4111-8111-111111111111";
const TARGET_ORG = "22222222-2222-4222-8222-222222222222";
const OPERATOR_USER = "ops-user";
const MEMBERSHIP = "30000000-0000-4000-8000-000000000001";
const PE_ID = "40000000-0000-4000-8000-000000000001";

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
  readonly id?: string;
  readonly expectedVersion?: number | undefined;
}

function recordingService(calls: Call[]): OnboardingDataService {
  const list = (method: string) => async (op: OnboardingOperator, orgSlug: string) => {
    calls.push({ method, op, orgSlug });
    return { items: [] };
  };
  const write =
    (method: string, hasId: boolean) =>
    async (op: OnboardingOperator, orgSlug: string, ...rest: unknown[]) => {
      const offset = hasId ? 1 : 0;
      calls.push({
        method,
        op,
        orgSlug,
        ...(hasId ? { id: rest[0] as string } : {}),
        fields: rest[offset] as Record<string, unknown>,
        reason: rest[offset + 1] as string,
        expectedVersion: rest[offset + 2] as number | undefined,
      });
      return { ok: true };
    };
  return {
    listProviderEntities: list("listProviderEntities"),
    listLocations: list("listLocations"),
    listMacCredentials: list("listMacCredentials"),
    listMembers: list("listMembers"),
    listMedicaidCredentials: list("listMedicaidCredentials"),
    createProviderEntity: write("createProviderEntity", false),
    updateProviderEntity: write("updateProviderEntity", true),
    createLocation: write("createLocation", false),
    updateLocation: write("updateLocation", true),
    upsertMacCredential: write("upsertMacCredential", false),
    upsertMedicaidCredential: write("upsertMedicaidCredential", false),
  } as OnboardingDataService;
}

const GRANTS = {
  orgId: PLATFORM_ORG,
  userId: OPERATOR_USER,
  grants: [
    {
      roleKey: "platform_ops",
      enabled: true,
      expiresAt: null,
      permissionKeys: [
        "tenant_onboarding_data.read_platform",
        "tenant_onboarding_data.write_platform",
      ],
    },
  ],
};

function makeServer(calls: Call[]) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      GRANTS,
      // a tenant administrator holds neither key
      { orgId: TARGET_ORG, userId: "tenant-admin", grants: [] },
      // a platform role that is NOT platform_ops: holds the keys, fails the predicate
      { ...GRANTS, userId: "support-user" },
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
  reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountTenantPlatformRoutes(app, {} as DbClient, {
    onboardingData: { service: recordingService(calls) },
  });
  return app;
}

const OPS = {
  "x-test-user": OPERATOR_USER,
  "x-test-org": PLATFORM_ORG,
  "x-test-roles": "platform_ops",
};
let keySeq = 0;
/** A fresh `Idempotency-Key` per call: the global middleware refuses a reused key on a different request (409). */
const key = (): string => `k-${++keySeq}`;
const fresh = (): Record<string, string> => ({
  ...OPS,
  "x-step-up": "fresh",
  "idempotency-key": key(),
});
const URL_BASE = "/api/v1/platform/tenants/tenant-b";

const NEW_PE = {
  ccn: "444444",
  npi: "1679576722",
  legalName: "Sierra Hospice",
  taxId: "12-3456789",
  fiscalYearEnd: "0630",
  reason: "  Customer request, ticket CHG-1234  ",
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

describe("write guards (every write route)", () => {
  const WRITES: readonly {
    method: "POST" | "PATCH";
    url: string;
    payload: Record<string, unknown>;
  }[] = [
    { method: "POST", url: `${URL_BASE}/provider-entities`, payload: NEW_PE },
    {
      method: "PATCH",
      url: `${URL_BASE}/provider-entities/${PE_ID}`,
      payload: { legalName: "X", reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/locations`,
      payload: { providerEntityId: PE_ID, reason: "ticket CHG-1" },
    },
    {
      method: "PATCH",
      url: `${URL_BASE}/locations/${PE_ID}`,
      payload: { name: "X", reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/state-medicaid-credentials`,
      payload: {
        providerEntityId: PE_ID,
        serviceState: "CA",
        channel: "portal",
        tradingPartnerId: "TP1",
        activeFrom: "2026-01-01",
        reason: "ticket CHG-1",
      },
    },
    {
      method: "POST",
      url: `${URL_BASE}/mac-credentials`,
      payload: {
        providerEntityId: PE_ID,
        macJurisdiction: "JE",
        submitterId: "S1",
        tradingPartnerId: "T1",
        clientId: "c",
        clientSecret: "s",
        reason: "ticket CHG-1",
      },
    },
  ];

  for (const w of WRITES) {
    it(`${w.method} ${w.url.replace(URL_BASE, "")}: refuses a tenant admin, a non-platform_ops role, a stale step-up, an AI actor and a missing key`, async () => {
      const calls: Call[] = [];
      const app = makeServer(calls);
      const send = (headers: Record<string, string>) =>
        app.inject({ method: w.method, url: w.url, headers, payload: w.payload });

      const tenant = await send({
        "x-test-user": "tenant-admin",
        "x-test-org": TARGET_ORG,
        "x-test-roles": "org_admin",
        "x-step-up": "fresh",
        "idempotency-key": key(),
      });
      expect(tenant.statusCode).toBe(403);

      const support = await send({
        "x-test-user": "support-user",
        "x-test-org": PLATFORM_ORG,
        "x-test-roles": "platform_support_t2",
        "x-step-up": "fresh",
        "idempotency-key": key(),
      });
      expect(support.statusCode).toBe(403);

      const noStepUp = await send({ ...OPS, "idempotency-key": key() });
      expect(noStepUp.statusCode).toBe(403);
      expect(noStepUp.json().error?.code ?? noStepUp.json().code).toBe("STEP_UP_REQUIRED");

      const ai = await send({ ...fresh(), "x-actor-kind": "ai_agent" });
      expect(ai.statusCode).toBe(403);

      const { "idempotency-key": _omit, ...noKey } = fresh();
      const missingKey = await send(noKey);
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json().error?.code ?? missingKey.json().code).toBe(
        "IDEMPOTENCY_KEY_REQUIRED",
      );

      expect(calls).toEqual([]); // not one of the refusals reached the service
      await app.close();
    });
  }
});

describe("reason", () => {
  it("is required and checked after trimming: absent, short, whitespace-padded and over-long all answer 422", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const { reason: _drop, ...noReason } = NEW_PE;
    for (const payload of [
      noReason,
      { ...NEW_PE, reason: "short" },
      { ...NEW_PE, reason: "abcd    " },
      { ...NEW_PE, reason: " ".repeat(20) },
      { ...NEW_PE, reason: "x".repeat(501) },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `${URL_BASE}/provider-entities`,
        headers: fresh(),
        payload,
      });
      expect(res.statusCode, JSON.stringify((payload as { reason?: string }).reason ?? null)).toBe(
        422,
      );
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("reaches the service trimmed, with the body's own fields and no `reason` key", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const res = await app.inject({
      method: "POST",
      url: `${URL_BASE}/provider-entities`,
      headers: fresh(),
      payload: NEW_PE,
    });
    expect(res.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.reason).toBe("Customer request, ticket CHG-1234");
    expect(call?.orgSlug).toBe("tenant-b");
    expect(call?.fields).toMatchObject({ ccn: "444444", taxId: "12-3456789" });
    expect(call?.fields).not.toHaveProperty("reason");
    // the operator is the SESSION, never the body
    expect(call?.op).toMatchObject({
      userId: OPERATOR_USER,
      membershipId: MEMBERSHIP,
      organizationId: PLATFORM_ORG,
    });
    await app.close();
  });
});

describe("reason normalisation", () => {
  const post = (app: ReturnType<typeof makeServer>, reason: string) =>
    app.inject({
      method: "POST",
      url: `${URL_BASE}/provider-entities`,
      headers: fresh(),
      payload: { ...NEW_PE, reason },
    });

  it("strips control and format characters and collapses whitespace before the reason reaches the service", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    // NUL, a zero-width space, a bidi override, a newline and a tab: nothing a tenant auditor reads can hide in them.
    const res = await post(app, "Customer\u200b request,\n\t\u202eticket\u0000   CHG-1234");
    expect(res.statusCode, res.body).toBe(201);
    expect(calls[0]?.reason).toBe("Customer request, ticket CHG-1234");
    await app.close();
  });

  it("applies the 8-500 bounds to the NORMALISED reason", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    // 12 raw characters, 4 after the invisible ones are gone; and "abc  def" collapses to 7.
    expect(
      (await post(app, "ab\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200bcd")).statusCode,
    ).toBe(422);
    expect((await post(app, "abc  def")).statusCode).toBe(422);
    expect((await post(app, "abc  defg")).statusCode).toBe(201);
    expect(calls.map((c) => c.reason)).toEqual(["abc defg"]);
    await app.close();
  });
});

describe("mac credential version header", () => {
  const body = {
    providerEntityId: PE_ID,
    macJurisdiction: "JE",
    submitterId: "S1",
    tradingPartnerId: "T1",
    clientId: "c",
    clientSecret: "s",
    reason: "ticket CHG-1",
  };

  it("answers 201 on a first create and 200 on a version-checked update; a malformed version is a 422", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: `${URL_BASE}/mac-credentials`, headers, payload: body });
    expect((await post(fresh())).statusCode).toBe(201);
    expect((await post({ ...fresh(), "if-match": '"3"' })).statusCode).toBe(200);
    expect(calls.map((c) => c.expectedVersion)).toEqual([undefined, 3]);
    expect((await post({ ...fresh(), "if-match": "three" })).statusCode).toBe(422);
    await app.close();
  });
});

describe("read guards", () => {
  it("lists for platform_ops with the read key; a tenant admin and a keyless platform_ops are refused", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const ok = await app.inject({
      method: "GET",
      url: `${URL_BASE}/provider-entities`,
      headers: OPS,
    });
    expect(ok.statusCode).toBe(200);
    const tenant = await app.inject({
      method: "GET",
      url: `${URL_BASE}/provider-entities`,
      headers: {
        "x-test-user": "tenant-admin",
        "x-test-org": TARGET_ORG,
        "x-test-roles": "org_admin",
      },
    });
    expect(tenant.statusCode).toBe(403);
    const keyless = await app.inject({
      method: "GET",
      url: `${URL_BASE}/provider-entities`,
      headers: { ...OPS, "x-test-user": "no-grants-user" },
    });
    expect(keyless.statusCode).toBe(403);
    expect(calls.map((c) => c.method)).toEqual(["listProviderEntities"]);
    await app.close();
  });
});

// Slice 5 (G2): the compliance-officer picker reads who the tenant's active staff are. It is a read of onboarding data, so it is
// behind the same key pair as the other reads, never a write guard.
describe("members read (the compliance officer picker)", () => {
  it("answers platform_ops with the read key; a tenant admin, a non-platform_ops role and a keyless user are refused", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const ok = await app.inject({ method: "GET", url: `${URL_BASE}/members`, headers: OPS });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ items: [] });
    const tenant = await app.inject({
      method: "GET",
      url: `${URL_BASE}/members`,
      headers: {
        "x-test-user": "tenant-admin",
        "x-test-org": TARGET_ORG,
        "x-test-roles": "org_admin",
      },
    });
    expect(tenant.statusCode).toBe(403);
    const support = await app.inject({
      method: "GET",
      url: `${URL_BASE}/members`,
      headers: { ...OPS, "x-test-user": "support-user", "x-test-roles": "platform_support_t2" },
    });
    expect(support.statusCode).toBe(403);
    const keyless = await app.inject({
      method: "GET",
      url: `${URL_BASE}/members`,
      headers: { ...OPS, "x-test-user": "no-grants-user" },
    });
    expect(keyless.statusCode).toBe(403);
    expect(calls.map((c) => c.method)).toEqual(["listMembers"]);
    expect(calls[0]?.orgSlug).toBe("tenant-b");
    await app.close();
  });
});

describe("toMemberViews (the projection behind the picker)", () => {
  it("keeps the minimum a picker needs, trims a blank name to null, sorts by name then email, and groups roles per member", () => {
    const views = toMemberViews(
      [
        { membershipId: "m2", name: "  ", email: "zed@clinic.example" },
        { membershipId: "m1", name: " Ada Admin ", email: "ada@clinic.example" },
        { membershipId: "m3", name: "Bea Nurse", email: "bea@clinic.example" },
      ],
      [
        { membershipId: "m1", key: "org_admin" },
        { membershipId: "m1", key: "compliance_officer" },
        { membershipId: "m3", key: "rn" },
        { membershipId: "gone", key: "org_admin" },
      ],
    );
    expect(views).toEqual([
      {
        membershipId: "m1",
        displayName: "Ada Admin",
        email: "ada@clinic.example",
        roleKeys: ["compliance_officer", "org_admin"],
      },
      {
        membershipId: "m3",
        displayName: "Bea Nurse",
        email: "bea@clinic.example",
        roleKeys: ["rn"],
      },
      { membershipId: "m2", displayName: null, email: "zed@clinic.example", roleKeys: [] },
    ]);
  });
});

// ── the service over a stubbed database: the status lock and the audit row ─────────────────────────────

interface InsertedRow {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

const resolveTenant = async (slug: string) =>
  slug === "tenant-b" ? { organizationId: TARGET_ORG } : null;

function stubDb(tenantStatus: string | null, options: { failInserts?: boolean } = {}) {
  const inserts: InsertedRow[] = [];
  /** Every statement the service issues, in order: `exec:<sql text>` / `select:tenant_account`. */
  const trace: string[] = [];
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.tenantAccount)
      return tenantStatus === null ? [] : [{ status: tenantStatus }];
    return [];
  };
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === schema.tenantAccount) trace.push("select:tenant_account");
          return rowsFor(table);
        },
      }),
    }),
  });
  const tx: Record<string, unknown> = {
    select,
    // a nested `withOrgContext` (the site repository's scope) opens a savepoint on the open transaction
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (options.failInserts) throw new Error("audit insert refused");
        inserts.push({ table, values });
      },
    }),
    // `set_config('app.org_id' | 'app.user_id', …)` and the onboarding advisory lock
    execute: async (query: { queryChunks?: unknown[] }) => {
      trace.push(`exec:${JSON.stringify(query.queryChunks ?? query)}`);
      return undefined;
    },
  };
  const db = { select, transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db: db as unknown as DbClient, inserts, trace };
}

const OPERATOR: OnboardingOperator = {
  userId: "a0000000-0000-4000-8000-000000000001",
  membershipId: MEMBERSHIP,
  organizationId: PLATFORM_ORG,
  roles: ["platform_ops"],
  stepUpRecent: true,
  request: { correlationId: "corr-1", requestId: "req-1" },
};

describe("service: the status lock and the audit row", () => {
  it("accepts only provisioning and onboarding; every other tenant status is refused with 409 TENANT_NOT_ONBOARDING", async () => {
    for (const status of schema.tenantAccountStatus.enumValues) {
      const { db, inserts } = stubDb(status);
      const service = buildDrizzleOnboardingDataService({
        db,
        resolveTenant,
        macCredentials: {
          list: async () => [],
          upsert: async () => ({ resourceId: PE_ID, view: {} }),
        },
      });
      const writable = status === "provisioning" || status === "onboarding";
      const attempt = service.upsertMacCredential(
        OPERATOR,
        "tenant-b",
        { providerEntityId: PE_ID } as never,
        "ticket CHG-1",
        undefined,
      );
      if (writable) {
        // reaches the provider-entity ownership check (the stub has none): a 404, never the status refusal. The failed
        // attempt is audited as `write_failed`, never as the status refusal.
        await expect(attempt, status).rejects.toMatchObject({ statusCode: 404 });
        expect(
          inserts.map((i) => i.values.eventType),
          status,
        ).toEqual([ONBOARDING_DATA_AUDIT_EVENTS.writeFailed]);
      } else {
        await expect(attempt, status).rejects.toMatchObject({
          statusCode: 409,
          code: "TENANT_NOT_ONBOARDING",
        });
        // the refusal is itself audited: who tried, for which tenant, why, and the status they ran into
        expect(inserts, status).toHaveLength(1);
        expect(inserts[0]?.values).toMatchObject({
          eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeRefused,
          outcome: "denied",
          organizationId: TARGET_ORG,
          actorUserId: OPERATOR.userId,
          actorRole: "platform_ops",
          context: expect.objectContaining({
            reason: "ticket CHG-1",
            targetOrganizationId: TARGET_ORG,
            operatorMembershipId: MEMBERSHIP,
            tenantStatus: status,
          }),
        });
      }
    }
  });

  it("takes the SHARED onboarding lock before it reads the tenant status", async () => {
    const { db, trace } = stubDb("onboarding");
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant });
    await service.createLocation(OPERATOR, "tenant-b", {}, "ticket CHG-1").catch(() => undefined);
    const lock = trace.findIndex((t) => t.includes("pg_advisory_xact_lock_shared"));
    const status = trace.indexOf("select:tenant_account");
    expect(lock, trace.join("\n")).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(lock);
    // keyed on the tenant, so it shares a key space with the activation path and with no other tenant
    expect(trace[lock]).toContain("hashtextextended");
    expect(trace[lock]).toContain(`tenant-onboarding:${TARGET_ORG}`);
  });

  it("audits ANY failed attempt as a denied write_failed row (operator, tenant, reason, route, error code; no body values)", async () => {
    const { db, inserts } = stubDb("onboarding");
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant });
    const operator: OnboardingOperator = {
      ...OPERATOR,
      request: {
        ...OPERATOR.request,
        route: "POST /api/v1/platform/tenants/:orgSlug/locations",
      },
    };
    const secretLooking = "body-value-that-must-not-be-audited";
    await expect(
      service.createLocation(operator, "tenant-b", { name: secretLooking }, "ticket CHG-1"),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeFailed,
      outcome: "denied",
      organizationId: TARGET_ORG,
      actorUserId: OPERATOR.userId,
      actorRole: "platform_ops",
      context: expect.objectContaining({
        reason: "ticket CHG-1",
        targetOrganizationId: TARGET_ORG,
        operatorMembershipId: MEMBERSHIP,
        route: "POST /api/v1/platform/tenants/:orgSlug/locations",
        attemptedEvent: ONBOARDING_DATA_AUDIT_EVENTS.locationCreated,
        errorCode: expect.any(String),
      }),
    });
    expect(JSON.stringify(inserts[0]?.values)).not.toContain(secretLooking);
  });

  it("when the failed-attempt row cannot be written, logs it and still throws the ORIGINAL error", async () => {
    const { db } = stubDb("onboarding", { failInserts: true });
    const logged: unknown[] = [];
    const service = buildDrizzleOnboardingDataService({
      db,
      resolveTenant,
      logAuditError: (cause, context) => logged.push({ cause, context }),
    });
    await expect(
      service.createLocation(OPERATOR, "tenant-b", {}, "ticket CHG-1"),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ context: { organizationId: TARGET_ORG } });
  });

  it("answers 404 for an organization with no tenant account, and for an unknown slug", async () => {
    const noAccount = buildDrizzleOnboardingDataService({ db: stubDb(null).db, resolveTenant });
    await expect(
      noAccount.createLocation(OPERATOR, "tenant-b", {}, "ticket CHG-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
    const { db } = stubDb("onboarding");
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant });
    await expect(
      service.createLocation(OPERATOR, "no-such-tenant", {}, "ticket CHG-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.listLocations(OPERATOR, "no-such-tenant")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("fails closed with 503 when no platform credential is bound to resolve the tenant slug", async () => {
    const service = buildDrizzleOnboardingDataService({ db: stubDb("onboarding").db });
    await expect(
      service.createLocation(OPERATOR, "tenant-b", {}, "ticket CHG-1"),
    ).rejects.toMatchObject({ statusCode: 503, code: "PLATFORM_CONTEXT_UNAVAILABLE" });
  });

  it("503s the credential routes when the MAC adapter is not bound", async () => {
    const { db } = stubDb("onboarding");
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant });
    await expect(
      service.upsertMacCredential(
        OPERATOR,
        "tenant-b",
        { providerEntityId: PE_ID } as never,
        "ticket CHG-1",
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "ONBOARDING_CREDENTIALS_UNBOUND" });
    await expect(service.listMacCredentials(OPERATOR, "tenant-b")).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
