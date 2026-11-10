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
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { OnboardingClearinghousePort } from "../src/bootstrap/onboarding-clearinghouse-port";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import { createRouteRateLimit } from "../src/bootstrap/plugins/route-rate-limit";
import {
  type OnboardingDataService,
  type OnboardingOperator,
  buildDrizzleOnboardingDataService,
  mountTenantPlatformRoutes,
  targetTenantScopeOf,
} from "../src/modules/34-saas-tenant-platform/index";
import { ONBOARDING_DATA_AUDIT_EVENTS } from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-audit";

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
  request.context.attributes.membershipId =
    request.headers["x-test-no-membership"] === "1" ? undefined : MEMBERSHIP;
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
  /** The BAA verification's pin (the `baa.recordedAt` the operator read, its If-Match); a withdrawal's may be null (none sent). */
  readonly expected?: { readonly recordedAt: string | null };
  /** The BAA revoke's closed request (a reason code and a ticket reference); the verify's explicit acknowledgement. */
  readonly input?: { readonly reasonCode: string; readonly ticketRef: string };
  readonly options?: { readonly acknowledgePreviousRevocation?: boolean };
  /** `withdrawNoticeExternalFiling`: which notice (NOE / NOTR) and its id. */
  readonly noticeKind?: "noe" | "notr";
  readonly noticeId?: string;
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
    listMedicaidCredentials: list("listMedicaidCredentials"),
    createProviderEntity: write("createProviderEntity", false),
    updateProviderEntity: write("updateProviderEntity", true),
    createLocation: write("createLocation", false),
    updateLocation: write("updateLocation", true),
    upsertMacCredential: write("upsertMacCredential", false),
    upsertMedicaidCredential: write("upsertMedicaidCredential", false),
    // ADR-0053 amendment 2026-11-06: the clearinghouse routes answer the shapes the real service returns.
    getClearinghouse: async (op: OnboardingOperator, orgSlug: string) => {
      calls.push({ method: "getClearinghouse", op, orgSlug });
      return { vendor: null };
    },
    putClearinghouse: async (
      op: OnboardingOperator,
      orgSlug: string,
      fields: Record<string, unknown>,
      reason: string,
      expectedVersion: number | undefined,
    ) => {
      calls.push({ method: "putClearinghouse", op, orgSlug, fields, reason, expectedVersion });
      return { created: expectedVersion === undefined, view: { vendor: fields.vendor } };
    },
    verifyClearinghouse: async (
      op: OnboardingOperator,
      orgSlug: string,
      fields: Record<string, unknown>,
      reason: string,
    ) => {
      calls.push({ method: "verifyClearinghouse", op, orgSlug, fields, reason });
      return { config: { vendor: "claimmd" }, test: { outcome: "ok" } };
    },
    verifyClearinghouseBaa: async (
      op: OnboardingOperator,
      orgSlug: string,
      reason: string,
      expected: { recordedAt: string },
      options?: { acknowledgePreviousRevocation?: boolean },
    ) => {
      calls.push({ method: "verifyClearinghouseBaa", op, orgSlug, reason, expected, options });
      return { status: "verified", baa: { verified: { at: "2026-11-06T00:00:00.000Z" } } };
    },
    revokeClearinghouseBaa: async (
      op: OnboardingOperator,
      orgSlug: string,
      input: { reasonCode: string; ticketRef: string },
      expected: { recordedAt: string },
    ) => {
      calls.push({ method: "revokeClearinghouseBaa", op, orgSlug, input, expected });
      return { status: "verified", baa: { verified: null, revoked: true } };
    },
    releaseClearinghouseCredentials: async (
      op: OnboardingOperator,
      orgSlug: string,
      reason: string,
    ) => {
      calls.push({ method: "releaseClearinghouseCredentials", op, orgSlug, reason });
      return { released: 1, config: { vendor: "outside" } };
    },
    withdrawNoticeExternalFiling: async (
      op: OnboardingOperator,
      orgSlug: string,
      noticeKind: "noe" | "notr",
      noticeId: string,
      reason: string,
      expected: { recordedAt: string | null },
    ) => {
      calls.push({
        method: "withdrawNoticeExternalFiling",
        op,
        orgSlug,
        noticeKind,
        noticeId,
        reason,
        expected,
      });
      return { noticeKind, noticeId, externalFiling: null };
    },
  } as unknown as OnboardingDataService;
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
        "tenant_clearinghouse.read_platform",
        "tenant_clearinghouse.write_platform",
        "tenant_clearinghouse.verify_baa_platform",
        "tenant_clearinghouse.revoke_baa_platform",
        "tenant_clearinghouse.release_credential_platform",
        "tenant_notice_filing.withdraw_platform",
      ],
    },
  ],
};
/** An operator who may verify a tenant's BAA but may NOT revoke it: the two are separate keys. */
const VERIFIER_ONLY = {
  orgId: PLATFORM_ORG,
  userId: "verifier-only-user",
  grants: [
    {
      roleKey: "platform_ops",
      enabled: true,
      expiresAt: null,
      permissionKeys: [
        "tenant_clearinghouse.read_platform",
        "tenant_clearinghouse.verify_baa_platform",
      ],
    },
  ],
};
/** An operator who may set up a tenant's clearinghouse but may NOT verify its BAA (the two duties are separable keys). */
const WRITER_ONLY = {
  orgId: PLATFORM_ORG,
  userId: "writer-only-user",
  grants: [
    {
      roleKey: "platform_ops",
      enabled: true,
      expiresAt: null,
      permissionKeys: ["tenant_clearinghouse.read_platform", "tenant_clearinghouse.write_platform"],
    },
  ],
};

function makeServer(
  calls: Call[],
  clearinghouseVerifyRateLimit?: (request: never, reply: never) => Promise<void>,
  clearinghousePutRateLimit?: (request: never, reply: never) => Promise<void>,
  /** Replaces single service methods (a refusal the real service raises, which the recording stub never does). */
  serviceOverride: Partial<OnboardingDataService> = {},
  clearinghouseRevokeBaaRateLimit?: (request: never, reply: never) => Promise<void>,
) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      GRANTS,
      // a tenant administrator holds neither key
      { orgId: TARGET_ORG, userId: "tenant-admin", grants: [] },
      // a platform role that is NOT platform_ops: holds the keys, fails the predicate
      { ...GRANTS, userId: "support-user" },
      WRITER_ONLY,
      VERIFIER_ONLY,
    ]).store,
  );
  const reg = createPredicateRegistry();
  reg.register("tenant_lifecycle_platform_ops", async (c) => c.roles.includes("platform_ops"));
  reg.register("step_up_recent", async (c) => c.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountTenantPlatformRoutes(app, {} as DbClient, {
    onboardingData: {
      service: { ...recordingService(calls), ...serviceOverride },
      ...(clearinghouseVerifyRateLimit ? { clearinghouseVerifyRateLimit } : {}),
      ...(clearinghousePutRateLimit ? { clearinghousePutRateLimit } : {}),
      ...(clearinghouseRevokeBaaRateLimit ? { clearinghouseRevokeBaaRateLimit } : {}),
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
/** A fresh `Idempotency-Key` per call: the global middleware refuses a reused key on a different request (409). */
const key = (): string => `k-${++keySeq}`;
const fresh = (): Record<string, string> => ({
  ...OPS,
  "x-step-up": "fresh",
  "idempotency-key": key(),
});
const URL_BASE = "/api/v1/platform/tenants/tenant-b";
/** The `baa.recordedAt` of the record an operator read, as the verify route's If-Match names it. */
const BAA_PIN = "2026-11-05T21:30:00.123Z";
const BAA_PIN_HEADER = `"${BAA_PIN}"`;

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
    method: "POST" | "PATCH" | "PUT";
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
    {
      method: "PUT",
      url: `${URL_BASE}/clearinghouse`,
      payload: { vendor: "outside", reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/clearinghouse/verify`,
      payload: { reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/clearinghouse/baa/verify`,
      payload: { reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/clearinghouse/baa/revoke`,
      payload: { reasonCode: "other", ticketRef: "SEC-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/clearinghouse/credentials/release`,
      payload: { reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/noe-records/${PE_ID}/withdraw-external-filing`,
      payload: { reason: "ticket CHG-1" },
    },
    {
      method: "POST",
      url: `${URL_BASE}/notr-records/${PE_ID}/withdraw-external-filing`,
      payload: { reason: "ticket CHG-1" },
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

  it("screens the reason as typed, before the control strip: a control character between digits is a separator, not padding", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    // Synthetic area-900 digits. Stripped first, "900123456\u00017" is an unbroken ten-digit run, which the screen lets through
    // on purpose (NPIs, phone numbers); as typed it is nine digits and a stray one.
    const res = await post(app, "verified with patient 900123456\u00017 by phone");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(res.body).not.toContain("900123456");
    expect(calls).toEqual([]); // refused before the service
    // and a run of control characters longer than the screen's separator window hides nothing once it is stripped
    const padded = `verified patient 900${"\u0001".repeat(12)}12${"\u0001".repeat(12)}3456 by phone`;
    expect((await post(app, padded)).json().error.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    // a plain ten-digit ticket number is still a plain number
    expect((await post(app, "ticket 9001234567 opened by phone")).statusCode).toBe(201);
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

  it("answers 201 on a first create and 200 on a version-checked update; a malformed version is a 400 (the route kit's If-Match contract)", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: `${URL_BASE}/mac-credentials`, headers, payload: body });
    expect((await post(fresh())).statusCode).toBe(201);
    expect((await post({ ...fresh(), "if-match": '"3"' })).statusCode).toBe(200);
    expect(calls.map((c) => c.expectedVersion)).toEqual([undefined, 3]);
    const malformed = await post({ ...fresh(), "if-match": "three" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

describe("clearinghouse routes", () => {
  const put = (
    app: ReturnType<typeof makeServer>,
    headers: Record<string, string>,
    payload: object,
  ) => app.inject({ method: "PUT", url: `${URL_BASE}/clearinghouse`, headers, payload });
  const BODY = {
    vendor: "claimmd",
    mode: "test",
    secret: "fake-key-not-a-secret#1",
    reason: "ticket CHG-1",
  };

  it("answers 201 on a first choice and 200 on a version-checked change, and hands the service the body without its reason", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    expect((await put(app, fresh(), BODY)).statusCode).toBe(201);
    expect((await put(app, { ...fresh(), "if-match": '"2"' }, BODY)).statusCode).toBe(200);
    // a malformed version is the route kit's 400 VALIDATION_FAILED (it was a 422 from a local copy of the helper)
    expect((await put(app, { ...fresh(), "if-match": "two" }, BODY)).statusCode).toBe(400);
    expect(calls.map((c) => c.expectedVersion)).toEqual([undefined, 2]);
    expect(calls[0]?.fields).toEqual({
      vendor: "claimmd",
      mode: "test",
      secret: "fake-key-not-a-secret#1",
    });
    expect(calls[0]?.reason).toBe("ticket CHG-1");
    await app.close();
  });

  it("never echoes the credential back", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const res = await put(app, fresh(), BODY);
    expect(res.body).not.toContain("fake-key-not-a-secret");
    await app.close();
  });

  it("refuses an unknown vendor, a missing reason and a short credential before the service runs", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    expect((await put(app, fresh(), { ...BODY, vendor: "acme" })).statusCode).toBe(422);
    const { reason: _drop, ...noReason } = BODY;
    expect((await put(app, fresh(), noReason)).statusCode).toBe(422);
    expect((await put(app, fresh(), { ...BODY, secret: "short" })).statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("verify carries the operator, the reason and the verify body; GET is read-guarded; there is no platform activate (only the tenant's own admin activates)", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const verify = await app.inject({
      method: "POST",
      url: `${URL_BASE}/clearinghouse/verify`,
      headers: fresh(),
      payload: { evidenceNote: "Sandbox claim accepted, ticket OPS-9", reason: "ticket CHG-1" },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ config: { vendor: "claimmd" }, test: { outcome: "ok" } });
    // CW-AC-17: activation is the tenant's. The platform lane has no route for it, whatever its role and step-up.
    const activate = await app.inject({
      method: "POST",
      url: `${URL_BASE}/clearinghouse/activate`,
      headers: fresh(),
      payload: { reason: "ticket CHG-1" },
    });
    expect(activate.statusCode).toBe(404);
    const read = await app.inject({
      method: "GET",
      url: `${URL_BASE}/clearinghouse`,
      headers: OPS,
    });
    expect(read.statusCode).toBe(200);
    const tenant = await app.inject({
      method: "GET",
      url: `${URL_BASE}/clearinghouse`,
      headers: {
        "x-test-user": "tenant-admin",
        "x-test-org": TARGET_ORG,
        "x-test-roles": "org_admin",
      },
    });
    expect(tenant.statusCode).toBe(403);
    expect(calls.map((c) => c.method)).toEqual(["verifyClearinghouse", "getClearinghouse"]);
    expect(calls[0]?.fields).toEqual({ evidenceNote: "Sandbox claim accepted, ticket OPS-9" });
    expect(calls[0]?.op.userId).toBe(OPERATOR_USER);
    await app.close();
  });

  it("baa/verify is its own key: an operator who may write the clearinghouse may not verify the BAA; the operator and reason are carried", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>, payload: object = { reason: "ticket CHG-1" }) =>
      app.inject({
        method: "POST",
        url: `${URL_BASE}/clearinghouse/baa/verify`,
        headers: { "if-match": BAA_PIN_HEADER, ...headers },
        payload,
      });
    const writerOnly = await post({ ...fresh(), "x-test-user": "writer-only-user" });
    expect(writerOnly.statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect((await post(fresh(), {})).statusCode).toBe(422); // the reason is required
    const ok = await post(fresh());
    expect(ok.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["verifyClearinghouseBaa"]);
    expect(calls[0]).toMatchObject({ orgSlug: "tenant-b", reason: "ticket CHG-1" });
    expect(calls[0]?.op.userId).toBe(OPERATOR_USER);
    // the acknowledgement is the operator's explicit word: absent means false, and only a literal true is carried as true
    expect(calls[0]?.options).toEqual({ acknowledgePreviousRevocation: false });
    calls.length = 0;
    expect(
      (await post(fresh(), { reason: "ticket CHG-1", acknowledgePreviousRevocation: true }))
        .statusCode,
    ).toBe(200);
    expect(calls[0]?.options).toEqual({ acknowledgePreviousRevocation: true });
    expect(
      (await post(fresh(), { reason: "ticket CHG-1", acknowledgePreviousRevocation: "yes" }))
        .statusCode,
    ).toBe(422);
    await app.close();
  });

  const REVOKE_BODY = { reasonCode: "vendor_terminated", ticketRef: "SEC-42" };

  it("baa/revoke is its own key: an operator who may verify the BAA may not revoke it; the operator, the closed request and the pin are carried", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>, payload: object = REVOKE_BODY) =>
      app.inject({
        method: "POST",
        url: `${URL_BASE}/clearinghouse/baa/revoke`,
        headers: { "if-match": BAA_PIN_HEADER, ...headers },
        payload,
      });
    const verifierOnly = await post({ ...fresh(), "x-test-user": "verifier-only-user" });
    expect(verifierOnly.statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect((await post(fresh(), {})).statusCode).toBe(422); // the closed request is required
    const ok = await post(fresh());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ baa: { revoked: true } });
    expect(calls.map((c) => c.method)).toEqual(["revokeClearinghouseBaa"]);
    expect(calls[0]).toMatchObject({
      orgSlug: "tenant-b",
      input: REVOKE_BODY,
      expected: { recordedAt: BAA_PIN },
    });
    expect(calls[0]?.op.userId).toBe(OPERATOR_USER);
    await app.close();
  });

  it("baa/revoke is pinned to the record the operator read: If-Match is required (428) and must be a real timestamp (422)", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `${URL_BASE}/clearinghouse/baa/revoke`,
        headers: { ...fresh(), ...headers },
        payload: REVOKE_BODY,
      });

    const missing = await post({});
    expect(missing.statusCode).toBe(428);
    expect(missing.json().error?.code ?? missing.json().code).toBe("IF_MATCH_REQUIRED");
    for (const bad of ['"3"', '"yesterday"', '"2026-11-06"', '"2026-02-30T00:00:00.000Z"']) {
      expect((await post({ "if-match": bad })).statusCode, bad).toBe(422);
    }
    expect(calls).toEqual([]); // none of them reached the service

    for (const header of [
      BAA_PIN_HEADER,
      `W/${BAA_PIN_HEADER}`,
      BAA_PIN_HEADER.replaceAll('"', ""),
    ]) {
      calls.length = 0;
      expect((await post({ "if-match": header })).statusCode, header).toBe(200);
      expect(calls[0]).toMatchObject({ expected: { recordedAt: BAA_PIN } });
    }
    await app.close();
  });

  it("baa/revoke takes NO free text: a reason outside the closed set, a ticket that is not a ticket, and any other field are a 422 before the service runs", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: `${URL_BASE}/clearinghouse/baa/revoke`,
        headers: { "if-match": BAA_PIN_HEADER, ...fresh() },
        payload,
      });
    const bad: object[] = [
      // the old free-text request
      { reason: "Vendor ended the BAA, ticket SEC-42" },
      { ...REVOKE_BODY, reason: "Patient John Smith DOB 04/12/1941 phone 555-123-4567 BAA ended" },
      { reasonCode: "Vendor ended the BAA", ticketRef: "SEC-42" },
      { reasonCode: "terminated", ticketRef: "SEC-42" },
      { reasonCode: "other" },
      { ticketRef: "SEC-42" },
      { reasonCode: "other", ticketRef: "sec-42" },
      { reasonCode: "other", ticketRef: "SEC-42 John Smith DOB 04/12/1941" },
      { reasonCode: "other", ticketRef: "SEC-42\nphone 555-123-4567" },
      { reasonCode: "other", ticketRef: "X".repeat(40) },
    ];
    for (const payload of bad) {
      expect((await post(payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(calls).toEqual([]);
    for (const reasonCode of ["vendor_terminated", "account_closed", "baa_expired", "other"]) {
      expect((await post({ reasonCode, ticketRef: "A1-12345678" })).statusCode, reasonCode).toBe(
        200,
      );
    }
    await app.close();
  });

  it("baa/revoke answers a refusal of the service in the standard error envelope with its own code and status", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls, undefined, undefined, {
      revokeClearinghouseBaa: async () => {
        throw new ChartWardenError("CLEARINGHOUSE_BAA_REVOKED", "already revoked", 409);
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `${URL_BASE}/clearinghouse/baa/revoke`,
      headers: { "if-match": BAA_PIN_HEADER, ...fresh() },
      payload: REVOKE_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "CLEARINGHOUSE_BAA_REVOKED" });
    expect(res.json()).not.toHaveProperty("status", "verified");
    await app.close();
  });

  describe("baa/revoke is rate limited per operator, across tenants", () => {
    const limiter = (
      store = createInMemoryRateLimitStore(),
      failMode: "open" | "closed" = "open",
    ) =>
      createRouteRateLimit({
        store,
        // no scopeOf: the bucket is the operator in the platform org, so it counts every tenant the operator revokes
        limit: { perUser: 2, perOrg: 3, windowMs: 60_000, failMode },
        keyPrefix: "m34-clearinghouse-baa-revoke",
      }) as (request: never, reply: never) => Promise<void>;
    const revokeOn = (app: ReturnType<typeof makeServer>, slug: string, headers = fresh()) =>
      app.inject({
        method: "POST",
        url: `/api/v1/platform/tenants/${slug}/clearinghouse/baa/revoke`,
        headers: { "if-match": BAA_PIN_HEADER, ...headers },
        payload: REVOKE_BODY,
      });

    it("one operator cannot sweep tenants: past the cap, whichever tenant, it is a 429 and the service is not reached", async () => {
      const calls: Call[] = [];
      const app = makeServer(calls, undefined, undefined, {}, limiter());
      expect((await revokeOn(app, "tenant-a")).statusCode).toBe(200);
      expect((await revokeOn(app, "tenant-b")).statusCode).toBe(200);
      const third = await revokeOn(app, "tenant-c");
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBeDefined();
      expect(calls.map((c) => c.orgSlug)).toEqual(["tenant-a", "tenant-b"]);
      await app.close();
    });

    it("fails OPEN when the limiter's store is down: the stop still works (and is still audited and announced)", async () => {
      const calls: Call[] = [];
      const down = {
        increment: async () => {
          throw new Error("store down");
        },
      } as unknown as ReturnType<typeof createInMemoryRateLimitStore>;
      const app = makeServer(calls, undefined, undefined, {}, limiter(down, "open"));
      expect((await revokeOn(app, "tenant-a")).statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      await app.close();
    });
  });

  it("baa/verify is pinned to the record the operator read: If-Match (the record's recordedAt) is required and must be a real timestamp (re-review M1)", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `${URL_BASE}/clearinghouse/baa/verify`,
        headers: { ...fresh(), ...headers },
        payload: { reason: "ticket CHG-1" },
      });

    const missing = await post({});
    expect(missing.statusCode).toBe(428);
    expect(missing.json().error?.code ?? missing.json().code).toBe("IF_MATCH_REQUIRED");
    for (const bad of ['"3"', '"yesterday"', '"2026-11-06"', '"2026-02-30T00:00:00.000Z"']) {
      const res = await post({ "if-match": bad });
      expect(res.statusCode, bad).toBe(422);
    }
    expect(calls).toEqual([]); // none of them reached the service

    // quoted (ETag style), weak-prefixed and bare all name the same record
    for (const header of [
      BAA_PIN_HEADER,
      `W/${BAA_PIN_HEADER}`,
      BAA_PIN_HEADER.replaceAll('"', ""),
    ]) {
      calls.length = 0;
      const ok = await post({ "if-match": header });
      expect(ok.statusCode, header).toBe(200);
      expect(calls[0]).toMatchObject({ expected: { recordedAt: BAA_PIN } });
    }
    await app.close();
  });
});

describe.each([
  ["noe", "noe-records"],
  ["notr", "notr-records"],
] as const)("withdraw-external-filing (%s): an operator-only action", (kind, segment) => {
  const URL = `${URL_BASE}/${segment}/${PE_ID}/withdraw-external-filing`;
  const RECORDED_AT = "2026-11-09T10:30:00.123Z";
  const post = (
    app: ReturnType<typeof makeServer>,
    headers: Record<string, string>,
    payload: object = { reason: "Filed in error, ticket CHG-77" },
  ) =>
    app.inject({
      method: "POST",
      url: URL,
      headers: { "if-match": `"${RECORDED_AT}"`, ...headers },
      payload,
    });

  it("is its own key: an operator who may verify a BAA may not withdraw a filing record; a tenant admin never may", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const noKey = await post(app, { ...fresh(), "x-test-user": "writer-only-user" });
    expect(noKey.statusCode).toBe(403);
    const tenant = await post(app, {
      "x-test-user": "tenant-admin",
      "x-test-org": TARGET_ORG,
      "x-test-roles": "org_admin",
      "x-step-up": "fresh",
      "idempotency-key": key(),
    });
    expect(tenant.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("needs a reason (422), and carries the operator, the tenant, the notice, the reason and the pin to the service", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    expect((await post(app, fresh(), {})).statusCode).toBe(422);
    expect((await post(app, fresh(), { reason: "    short  " })).statusCode).toBe(422);
    expect(calls).toEqual([]);

    const ok = await post(app, fresh());
    expect(ok.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "withdrawNoticeExternalFiling",
      orgSlug: "tenant-b",
      noticeKind: kind,
      noticeId: PE_ID,
      reason: "Filed in error, ticket CHG-77",
      expected: { recordedAt: RECORDED_AT },
    });
    expect(calls[0]?.op.userId).toBe(OPERATOR_USER);
    await app.close();
  });

  it("is pinned to the record the operator read: If-Match (its recordedAt) must be a real timestamp (422); a missing one reaches the service, which answers 428 with the current recordedAt", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const bare = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: URL,
        headers: { ...fresh(), ...headers },
        payload: { reason: "Filed in error, ticket CHG-77" },
      });
    for (const badPin of ['"3"', '"yesterday"', '"2026-11-06"', '"2026-02-30T00:00:00.000Z"']) {
      expect((await bare({ "if-match": badPin })).statusCode, badPin).toBe(422);
    }
    expect(calls).toEqual([]);
    // no If-Match: the 428 needs the record's CURRENT recordedAt, which only the service can read, so it decides
    await bare({});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ expected: { recordedAt: null } });
    for (const header of [`"${RECORDED_AT}"`, `W/"${RECORDED_AT}"`, RECORDED_AT]) {
      calls.length = 0;
      expect((await bare({ "if-match": header })).statusCode, header).toBe(200);
      expect(calls[0]).toMatchObject({ expected: { recordedAt: RECORDED_AT } });
    }
    await app.close();
  });

  it("refuses a notice id that is not a uuid (422) before it reaches the service", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const res = await app.inject({
      method: "POST",
      url: `${URL_BASE}/${segment}/not-a-uuid/withdraw-external-filing`,
      headers: { "if-match": `"${RECORDED_AT}"`, ...fresh() },
      payload: { reason: "Filed in error, ticket CHG-77" },
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });
});

describe("the verify limiter counts per TARGET tenant (re-review L7)", () => {
  const limiter = () =>
    createRouteRateLimit({
      store: createInMemoryRateLimitStore(),
      limit: { perUser: 2, perOrg: 3, windowMs: 60_000, failMode: "closed" },
      keyPrefix: "t-verify",
      scopeOf: targetTenantScopeOf,
    }) as unknown as (request: never, reply: never) => Promise<void>;
  const verifyOf = (app: ReturnType<typeof makeServer>, slug: string, user = OPERATOR_USER) =>
    app.inject({
      method: "POST",
      url: `/api/v1/platform/tenants/${slug}/clearinghouse/verify`,
      headers: { ...fresh(), "x-test-user": user },
      payload: { reason: "ticket CHG-1" },
    });

  it("an operator who exhausts one tenant's budget still verifies another tenant, and the cap is per tenant", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls, limiter());
    expect((await verifyOf(app, "tenant-b")).statusCode).toBe(200);
    expect((await verifyOf(app, "tenant-b")).statusCode).toBe(200);
    expect((await verifyOf(app, "tenant-b")).statusCode).toBe(429); // this operator's cap for tenant-b
    expect((await verifyOf(app, "tenant-c")).statusCode).toBe(200); // not tenant-c's
    expect(calls.filter((c) => c.method === "verifyClearinghouse")).toHaveLength(3);
    await app.close();
  });

  it("the per-tenant (org) bucket is the tenant's own: it is not the operator's platform org, shared by every tenant", async () => {
    const roomy = createRouteRateLimit({
      store: createInMemoryRateLimitStore(),
      limit: { perUser: 50, perOrg: 3, windowMs: 60_000, failMode: "closed" },
      keyPrefix: "t-verify-org",
      scopeOf: targetTenantScopeOf,
    }) as unknown as (request: never, reply: never) => Promise<void>;
    const app = makeServer([], roomy);
    for (let i = 0; i < 3; i++) expect((await verifyOf(app, "tenant-b")).statusCode).toBe(200);
    expect((await verifyOf(app, "tenant-b")).statusCode).toBe(429); // tenant-b's own cap, 3/3
    for (let i = 0; i < 3; i++) expect((await verifyOf(app, "tenant-c")).statusCode).toBe(200);
    await app.close();
  });
});

// CH-6: the platform PUT returns the same 409 CLEARINGHOUSE_ACCOUNT_IN_USE oracle as the tenant's own PUT, so it carries the same
// cap (CLEARINGHOUSE_PUT_ROUTE_RATE_LIMIT, fail-closed), counted per TARGET tenant like the verify limiter above.
describe("the clearinghouse PUT limiter (CH-6)", () => {
  const BODY = {
    vendor: "claimmd",
    mode: "test",
    secret: "fake-key-not-a-secret#1",
    reason: "ticket CHG-1",
  };
  const putOf = (app: ReturnType<typeof makeServer>, slug: string) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/platform/tenants/${slug}/clearinghouse`,
      headers: fresh(),
      payload: BODY,
    });
  const limiter = (store = createInMemoryRateLimitStore()) =>
    createRouteRateLimit({
      store,
      limit: { perUser: 2, perOrg: 50, windowMs: 60_000, failMode: "closed" },
      keyPrefix: "t-put",
      scopeOf: targetTenantScopeOf,
    }) as unknown as (request: never, reply: never) => Promise<void>;

  it("caps the PUT per operator and target tenant (429), and another tenant keeps its own budget", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls, undefined, limiter());
    expect((await putOf(app, "tenant-b")).statusCode).toBe(201);
    expect((await putOf(app, "tenant-b")).statusCode).toBe(201);
    expect((await putOf(app, "tenant-b")).statusCode).toBe(429);
    expect((await putOf(app, "tenant-c")).statusCode).toBe(201);
    expect(calls.filter((c) => c.method === "putClearinghouse")).toHaveLength(3); // the 429 never reached the service
    await app.close();
  });

  it("fails CLOSED with a typed 503 when the limiter's store is down, and never calls the service", async () => {
    const calls: Call[] = [];
    const down = {
      increment: async () => {
        throw new Error("store down");
      },
    };
    const app = makeServer(calls, undefined, limiter(down));
    const res = await putOf(app, "tenant-b");
    expect(res.statusCode, res.body).toBe(503);
    expect(calls.filter((c) => c.method === "putClearinghouse")).toEqual([]);
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
    // a write also voids a pending go-live attestation (`voidPendingGoLiveForDataChange`): the stub has none to revoke
    update: (table: unknown) => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            if (table === schema.tenantGoLiveAttestation) {
              trace.push("update:tenant_go_live_attestation");
            }
            return [];
          },
        }),
      }),
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

// ── the clearinghouse writes: the same lock, the same audit row, and the wizard step settles after commit ───────────

describe("service: the clearinghouse choice", () => {
  const CONFIG_ID = "50000000-0000-4000-8000-000000000001";
  const SECRET = "fake-key-not-a-secret#1";

  it("credentials/release is its own key: an operator who may write the clearinghouse may not release; the operator and reason are carried", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const post = (headers: Record<string, string>, payload: object = { reason: "ticket CHG-2" }) =>
      app.inject({
        method: "POST",
        url: `${URL_BASE}/clearinghouse/credentials/release`,
        headers,
        payload,
      });
    expect((await post({ ...fresh(), "x-test-user": "writer-only-user" })).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect((await post(fresh(), {})).statusCode).toBe(422); // the reason is required
    const ok = await post(fresh());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ released: 1, config: { vendor: "outside" } });
    expect(calls.map((c) => c.method)).toEqual(["releaseClearinghouseCredentials"]);
    expect(calls[0]).toMatchObject({ orgSlug: "tenant-b", reason: "ticket CHG-2" });
    expect(calls[0]?.op.userId).toBe(OPERATOR_USER);
    await app.close();
  });

  function fakePort(over: Partial<OnboardingClearinghousePort> = {}, trace: string[] = []) {
    const seen: {
      method: string;
      body?: unknown;
      expectedVersion?: number | undefined;
      expected?: unknown;
    }[] = [];
    const port: OnboardingClearinghousePort = {
      get: async () => ({ vendor: null }),
      put: async (_tx, _scope, body, expectedVersion) => {
        seen.push({ method: "put", body, expectedVersion });
        return {
          resourceId: CONFIG_ID,
          created: expectedVersion === undefined,
          view: { vendor: "claimmd", hasSecret: true },
          changedFields: Object.keys(body as object),
        };
      },
      // verify is three steps; the probe is the one that must never run inside the write transaction
      prepareVerify: async (_scope, body) => {
        trace.push("prepare");
        seen.push({ method: "prepareVerify", body });
        return { version: 4 };
      },
      runProbe: async () => {
        trace.push("PROBE");
        return { outcome: "ok" };
      },
      completeVerify: async (_tx, _scope, plan, outcome) => {
        trace.push("complete");
        seen.push({ method: "completeVerify", body: { plan, outcome } });
        return {
          resourceId: CONFIG_ID,
          view: { status: "verified" },
          test: outcome as object,
          detail: { verificationKind: "connection_test", testOutcome: "ok" },
        };
      },
      verifyBaa: async (_tx: unknown, _scope: unknown, expected: unknown) => {
        seen.push({ method: "verifyBaa", expected });
        return { resourceId: CONFIG_ID, view: { status: "verified", baa: { verified: {} } } };
      },
      revokeBaa: async (_tx: unknown, _scope: unknown, expected: unknown, input: unknown) => {
        seen.push({ method: "revokeBaa", expected, body: input });
        return {
          resourceId: CONFIG_ID,
          view: { status: "verified", baa: { verified: null, revoked: true } },
          detail: { baaRevoked: true, wasActive: true, vendor: "claimmd" },
        };
      },
      releaseCredentials: async (_tx, _scope, reason) => {
        seen.push({ method: "releaseCredentials", body: reason });
        return {
          resourceId: CONFIG_ID,
          view: { released: 2, config: { vendor: "outside" } },
          detail: { released: 2 },
        };
      },
      ...over,
    };
    return { port, seen };
  }

  it("a put lands in the tenant's own scope with an audit row naming operator, tenant, reason and the FIELD names only", async () => {
    const { db, inserts } = stubDb("onboarding");
    const { port, seen } = fakePort();
    const settled: string[] = [];
    const service = buildDrizzleOnboardingDataService({
      db,
      resolveTenant,
      clearinghouse: port,
      settleOnboarding: async (org) => void settled.push(org),
    });
    const out = await service.putClearinghouse(
      OPERATOR,
      "tenant-b",
      { vendor: "claimmd", mode: "test", secret: SECRET },
      "ticket CHG-1",
      undefined,
    );
    expect(out).toMatchObject({ created: true });
    expect(seen[0]?.body).toEqual({ vendor: "claimmd", mode: "test", secret: SECRET });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.clearinghouseSet,
      resourceId: CONFIG_ID,
      outcome: "success",
      organizationId: TARGET_ORG,
      actorUserId: OPERATOR.userId,
      context: expect.objectContaining({
        reason: "ticket CHG-1",
        targetOrganizationId: TARGET_ORG,
        changedFields: ["vendor", "mode", "secret"],
      }),
    });
    expect(JSON.stringify(inserts[0]?.values)).not.toContain(SECRET);
    expect(settled).toEqual([TARGET_ORG]);
  });

  it("does not void a pending go-live attestation for idempotent clearinghouse writes", async () => {
    const putDb = stubDb("onboarding");
    const noOpPut = fakePort({
      put: async () => ({
        resourceId: CONFIG_ID,
        created: false,
        view: { vendor: "claimmd", hasSecret: true },
        changedFields: [],
      }),
    });
    const putService = buildDrizzleOnboardingDataService({
      db: putDb.db,
      resolveTenant,
      clearinghouse: noOpPut.port,
    });
    await putService.putClearinghouse(
      OPERATOR,
      "tenant-b",
      { vendor: "claimmd", mode: "test" },
      "ticket CHG-1",
      4,
    );
    expect(putDb.trace).not.toContain("update:tenant_go_live_attestation");

    const verifyDb = stubDb("active");
    const noOpVerify = fakePort({
      verifyBaa: async () => ({
        resourceId: CONFIG_ID,
        view: { status: "verified", baa: { verified: {} } },
        dataChanged: false,
      }),
    });
    const verifyService = buildDrizzleOnboardingDataService({
      db: verifyDb.db,
      resolveTenant,
      clearinghouse: noOpVerify.port,
    });
    await verifyService.verifyClearinghouseBaa(OPERATOR, "tenant-b", "ticket CHG-7", {
      recordedAt: BAA_PIN,
    });
    expect(verifyDb.trace).not.toContain("update:tenant_go_live_attestation");
  });

  it("verify audits how it was verified and the test outcome and settles the wizard step", async () => {
    const { db, inserts } = stubDb("provisioning");
    const { port } = fakePort();
    const settled: string[] = [];
    const service = buildDrizzleOnboardingDataService({
      db,
      resolveTenant,
      clearinghouse: port,
      settleOnboarding: async (org) => void settled.push(org),
    });
    const verified = await service.verifyClearinghouse(OPERATOR, "tenant-b", {}, "ticket CHG-1");
    expect(verified).toEqual({ config: { status: "verified" }, test: { outcome: "ok" } });
    expect(inserts.map((i) => i.values.eventType)).toEqual([
      ONBOARDING_DATA_AUDIT_EVENTS.clearinghouseVerified,
    ]);
    expect(inserts[0]?.values.context).toMatchObject({
      verificationKind: "connection_test",
      testOutcome: "ok",
    });
    expect(settled).toEqual([TARGET_ORG]);
  });

  it("is refused once the tenant is active (409 TENANT_NOT_ONBOARDING), audited, and nothing is settled", async () => {
    const { db, inserts } = stubDb("active");
    const { port, seen } = fakePort();
    const settled: string[] = [];
    const service = buildDrizzleOnboardingDataService({
      db,
      resolveTenant,
      clearinghouse: port,
      settleOnboarding: async (org) => void settled.push(org),
    });
    await expect(
      service.putClearinghouse(
        OPERATOR,
        "tenant-b",
        { vendor: "outside" },
        "ticket CHG-1",
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "TENANT_NOT_ONBOARDING" });
    expect(seen).toEqual([]);
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeRefused,
      context: expect.objectContaining({
        attemptedEvent: ONBOARDING_DATA_AUDIT_EVENTS.clearinghouseSet,
      }),
    });
    expect(settled).toEqual([]);
  });

  it("a failing settle is logged and never fails the committed write", async () => {
    const { db } = stubDb("onboarding");
    const { port } = fakePort();
    const failure = new Error("advance failed");
    const warned: { message: string; context: Record<string, unknown> }[] = [];
    const errored: unknown[] = [];
    const service = buildDrizzleOnboardingDataService({
      db,
      resolveTenant,
      clearinghouse: port,
      settleOnboarding: async () => {
        throw failure;
      },
      warn: (message, context) => warned.push({ message, context }),
      logError: (cause) => errored.push(cause),
    });
    await expect(
      service.verifyClearinghouse(OPERATOR, "tenant-b", {}, "ticket CHG-1"),
    ).resolves.toEqual({ config: { status: "verified" }, test: { outcome: "ok" } });
    // warned with its own message and the raw error (for the redacting logger), never through the tax-id `logError`
    expect(warned).toEqual([
      {
        message: "m34.onboarding data: onboarding settle after a clearinghouse change failed",
        context: { organizationId: expect.any(String), err: failure },
      },
    ]);
    expect(errored).toEqual([]);
  });

  it("answers 503 when the clearinghouse adapter is not bound, and audits the failed attempt", async () => {
    const { db, inserts } = stubDb("onboarding");
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant });
    await expect(
      service.putClearinghouse(
        OPERATOR,
        "tenant-b",
        { vendor: "outside" },
        "ticket CHG-1",
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "ONBOARDING_CLEARINGHOUSE_UNBOUND" });
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeFailed,
    });
  });

  it("a read is audited, with a count and no data", async () => {
    const { db, inserts } = stubDb("onboarding");
    const { port } = fakePort();
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, clearinghouse: port });
    await expect(service.getClearinghouse(OPERATOR, "tenant-b")).resolves.toEqual({ vendor: null });
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.dataRead,
      resourceKind: "tenant_clearinghouse_config",
    });
  });
  it("verify runs the vendor probe with NO transaction open: read first, probe, then the write transaction compare-and-sets", async () => {
    const { db } = stubDb("onboarding");
    const order: string[] = [];
    const { port } = fakePort({}, order);
    // the stub db's transaction, announced into the same ordered log the port writes to
    const original = db.transaction.bind(db);
    const traced = {
      ...db,
      transaction: (fn: Parameters<typeof original>[0]) => {
        order.push("TX_OPEN");
        return original(fn);
      },
    } as unknown as typeof db;
    const service = buildDrizzleOnboardingDataService({
      db: traced,
      resolveTenant,
      clearinghouse: port,
    });
    await service.verifyClearinghouse(OPERATOR, "tenant-b", {}, "ticket CHG-1");
    const probe = order.indexOf("PROBE");
    expect(probe).toBeGreaterThan(-1);
    // the read-only step 1 and the probe happen before any transaction opens; `complete` runs only inside the write one
    expect(order.slice(0, probe)).not.toContain("TX_OPEN");
    expect(order.slice(0, probe)).not.toContain("complete");
    expect(order.indexOf("TX_OPEN")).toBeGreaterThan(probe);
    expect(order.indexOf("complete")).toBeGreaterThan(order.indexOf("TX_OPEN"));
  });

  it("surfaces a config that moved during the probe as 409 and audits the failed attempt", async () => {
    const { db, inserts } = stubDb("onboarding");
    const { port } = fakePort({
      completeVerify: async () => {
        throw new ChartWardenError("CLEARINGHOUSE_CHANGED_DURING_VERIFY", "moved", 409);
      },
    });
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, clearinghouse: port });
    await expect(
      service.verifyClearinghouse(OPERATOR, "tenant-b", {}, "ticket CHG-1"),
    ).rejects.toMatchObject({ statusCode: 409, code: "CLEARINGHOUSE_CHANGED_DURING_VERIFY" });
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeFailed,
      context: expect.objectContaining({ errorCode: "CLEARINGHOUSE_CHANGED_DURING_VERIFY" }),
    });
  });

  it("the BAA verification is audited with operator, org and reason, and is NOT refused for a live tenant (it needs it after a vendor change)", async () => {
    for (const status of ["onboarding", "active"]) {
      const { db, inserts } = stubDb(status);
      const { port, seen } = fakePort();
      const settled: string[] = [];
      const service = buildDrizzleOnboardingDataService({
        db,
        resolveTenant,
        clearinghouse: port,
        settleOnboarding: async (org) => void settled.push(org),
      });
      await expect(
        service.verifyClearinghouseBaa(OPERATOR, "tenant-b", "ticket CHG-7", {
          recordedAt: BAA_PIN,
        }),
      ).resolves.toMatchObject({ status: "verified" });
      expect(
        seen.map((x) => x.method),
        status,
      ).toEqual(["verifyBaa"]);
      expect(seen[0]?.expected, status).toEqual({ recordedAt: BAA_PIN }); // the port compares it under the row lock
      expect(inserts, status).toHaveLength(1);
      expect(inserts[0]?.values, status).toMatchObject({
        eventType: ONBOARDING_DATA_AUDIT_EVENTS.clearinghouseBaaVerified,
        resourceId: CONFIG_ID,
        outcome: "success",
        organizationId: TARGET_ORG,
        actorUserId: OPERATOR.userId,
        context: expect.objectContaining({
          reason: "ticket CHG-7",
          targetOrganizationId: TARGET_ORG,
          operatorMembershipId: MEMBERSHIP,
        }),
      });
    }
  });

  it("the BAA revoke is audited with operator, org, the closed code, the ticket and the vendor, and is NOT refused for a live tenant (a live tenant is the point)", async () => {
    for (const status of ["onboarding", "active"]) {
      const { db, inserts } = stubDb(status);
      const { port, seen } = fakePort();
      const settled: string[] = [];
      const service = buildDrizzleOnboardingDataService({
        db,
        resolveTenant,
        clearinghouse: port,
        settleOnboarding: async (org) => void settled.push(org),
      });
      await expect(
        service.revokeClearinghouseBaa(
          OPERATOR,
          "tenant-b",
          { reasonCode: "vendor_terminated", ticketRef: "SEC-42" },
          { recordedAt: BAA_PIN },
        ),
      ).resolves.toMatchObject({ status: "verified", baa: { revoked: true } });
      expect(
        seen.map((x) => x.method),
        status,
      ).toEqual(["revokeBaa"]);
      // the pin and the closed request reach M23, which compares the pin under the row lock and validates the request
      expect(seen[0], status).toMatchObject({
        expected: { recordedAt: BAA_PIN },
        body: { reasonCode: "vendor_terminated", ticketRef: "SEC-42" },
      });
      expect(inserts, status).toHaveLength(1);
      expect(inserts[0]?.values, status).toMatchObject({
        eventType: ONBOARDING_DATA_AUDIT_EVENTS.clearinghouseBaaRevoked,
        resourceId: CONFIG_ID,
        outcome: "success",
        organizationId: TARGET_ORG,
        actorUserId: OPERATOR.userId,
        context: expect.objectContaining({
          // built here from the two validated request fields: the only "reason" text this audit row can hold
          reason: "baa_revoked:vendor_terminated:SEC-42",
          targetOrganizationId: TARGET_ORG,
          operatorMembershipId: MEMBERSHIP,
          baaRevoked: true,
          wasActive: true,
          vendor: "claimmd",
        }),
      });
    }
  });

  it("a revoke request that skipped the route's schema is refused before ANY audit row: no caller text can reach a write_failed row", async () => {
    const { db, inserts } = stubDb("active");
    const { port, seen } = fakePort();
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, clearinghouse: port });
    const SENTENCE = "Patient John Smith DOB 04/12/1941 phone 555-123-4567 BAA ended";
    for (const input of [
      { reasonCode: SENTENCE, ticketRef: "SEC-42" },
      { reasonCode: "other", ticketRef: SENTENCE },
      { reasonCode: "other", ticketRef: "sec-42" },
    ]) {
      await expect(
        service.revokeClearinghouseBaa(OPERATOR, "tenant-b", input, { recordedAt: BAA_PIN }),
      ).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
    }
    expect(inserts).toEqual([]); // nothing audited, so nothing to carry the text
    expect(seen).toEqual([]); // and M23 was never reached
  });

  it("a refused BAA revoke leaves a write_failed audit row with its code and changes nothing else", async () => {
    const { db, inserts } = stubDb("active");
    const { port } = fakePort({
      revokeBaa: async () => {
        throw new ChartWardenError("CLEARINGHOUSE_BAA_REVOKED", "already revoked", 409);
      },
    });
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, clearinghouse: port });
    await expect(
      service.revokeClearinghouseBaa(
        OPERATOR,
        "tenant-b",
        { reasonCode: "other", ticketRef: "SEC-42" },
        { recordedAt: BAA_PIN },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "CLEARINGHOUSE_BAA_REVOKED" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toMatchObject({
      eventType: ONBOARDING_DATA_AUDIT_EVENTS.writeFailed,
      context: expect.objectContaining({
        errorCode: "CLEARINGHOUSE_BAA_REVOKED",
        // a refused revoke records the same built string: there is no caller-supplied text to store in a write_failed row
        reason: "baa_revoked:other:SEC-42",
      }),
    });
  });

  it("the credential release is audited with operator, org, reason and the count, and is NOT refused for a live tenant", async () => {
    for (const status of ["onboarding", "active"]) {
      const { db, inserts } = stubDb(status);
      const { port, seen } = fakePort();
      const service = buildDrizzleOnboardingDataService({ db, resolveTenant, clearinghouse: port });
      await expect(
        service.releaseClearinghouseCredentials(OPERATOR, "tenant-b", "ticket CHG-8"),
      ).resolves.toEqual({ released: 2, config: { vendor: "outside" } });
      expect(seen, status).toEqual([{ method: "releaseCredentials", body: "ticket CHG-8" }]);
      expect(inserts, status).toHaveLength(1);
      expect(inserts[0]?.values, status).toMatchObject({
        eventType: ONBOARDING_DATA_AUDIT_EVENTS.clearinghouseCredentialsReleased,
        resourceId: CONFIG_ID,
        outcome: "success",
        organizationId: TARGET_ORG,
        actorUserId: OPERATOR.userId,
        context: expect.objectContaining({ reason: "ticket CHG-8", released: 2 }),
      });
    }
  });

  it("still refuses an unknown tenant slug on the BAA verification (404, non-leaking)", async () => {
    const { db } = stubDb("active");
    const { port } = fakePort();
    const service = buildDrizzleOnboardingDataService({ db, resolveTenant, clearinghouse: port });
    await expect(
      service.verifyClearinghouseBaa(OPERATOR, "no-such-tenant", "ticket CHG-7", {
        recordedAt: BAA_PIN,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("a live session with no membership (the route kit's 403 contract, never a 401 sign-out)", () => {
  it("is 403 on a read and on a write, and the service is never reached", async () => {
    const calls: Call[] = [];
    const app = makeServer(calls);
    const read = await app.inject({
      method: "GET",
      url: `${URL_BASE}/provider-entities`,
      headers: { ...OPS, "x-test-no-membership": "1" },
    });
    expect(read.statusCode).toBe(403);
    expect(read.json().error.message).toMatch(/active membership is required/i);
    const write = await app.inject({
      method: "POST",
      url: `${URL_BASE}/provider-entities`,
      headers: { ...fresh(), "x-test-no-membership": "1" },
      payload: NEW_PE,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.message).toMatch(/active membership is required/i);
    expect(calls).toEqual([]);
    await app.close();
  });
});
