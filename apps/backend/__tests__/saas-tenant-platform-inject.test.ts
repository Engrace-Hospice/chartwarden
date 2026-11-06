import { readFileSync } from "node:fs";
import { join } from "node:path";
// apps/backend/__tests__/saas-tenant-platform-inject.test.ts — M34 (SaaS Tenant Platform) §4.1 route-
// inventory HTTP-layer smoke test (TASK-050A / TEST-001). Before this file, M34 had zero `app.inject()`
// coverage — the module is the largest fan-out in this remediation effort: fifteen `register*Routes`
// plugins (four platform-ops files register EIGHT plugins, one tenant barrel registers FIVE, one public
// file registers one) wired through a single composition-root aggregator, `mountTenantPlatformRoutes`
// (apps/backend/src/modules/34-saas-tenant-platform/index.ts), across FORTY-EIGHT distinct Fastify route
// registrations (verified via `grep -c 'app\.\(get\|post\|put\|patch\|delete\)('` over `routes/` — the
// task brief's "~66" estimate does not match the actual inventory; 48 is the ground truth this file
// exercises exhaustively).
//
// Clones the `orders-routes.test.ts` / `fhir-inject.test.ts` (M11-T06 / TASK-050A) precedent exactly:
// `buildServer()` mounts the host, a header-auth shim populates `request.context`, and a FRESH
// `createPredicateRegistry()` is seeded with M34's eight §4.6 predicates (`buildTenantPlatformAbacPredicates`
// over a small hand-rolled `TenantPlatformAbacResolver`) plus a permissive `step_up_recent` stand-in for
// the eleven `requireStepUp` gates this module carries (M3 owns that predicate; a fresh registry starts
// without it — the M28 precedent for a composed-but-foreign predicate).
//
// `mountTenantPlatformRoutes(app, db, services)` takes BOTH in-memory backends the module exports —
// `createInMemoryTenantPlatformBackend` (platform-ops surface) and `createInMemoryTenantBackend`
// (tenant-scoped surface) — directly, with no adaptation (the `orders-routes.test.ts`
// `createInMemoryOrderBackend` precedent). `db` is accepted but never read (`void db;` in the mount
// function body — the Drizzle services carry their own pooled handles), so a bare `{} as DbClient` stub
// satisfies the signature (the `consent-routes-mount.test.ts` precedent).
//
// TWO DOCUMENTED, NOT FABRICATED, DEVIATIONS FROM "one 2xx per route":
//   1. The PUBLIC self-serve-signup surface (three routes, `routes/public/signup-intents.ts`) is mounted
//      by `mountTenantPlatformRoutes` with NO `signupGate` injected, so it falls back to
//      `createDenyDefaultSelfServeSignupGate()` — every one of those three routes answers
//      `503 SIGNUP_DISABLED` UNCONDITIONALLY (the gate fires before body parsing or any auth check, and
//      `mountTenantPlatformRoutes`'s `services` parameter has no slot to inject a custom gate). This is
//      the Phase-1 platform default (D14), not a bug — the FHIR-gateway R3 precedent for a route that is
//      DESIGNED to never answer 2xx in this phase. All three are asserted at their real 503.
//   2. `dsar_export_patient_caseload_or_org_admin`'s target-mapper on the per-:id routes (fulfill / extend
//      / deny / download) defaults to `request.params`, which carries only `id` (the job id) — the target
//      never carries `patientId` on those four routes (only the REQUEST route's target mapper reads it off
//      the body). So a non-`org_admin` caseload member is fail-closed-denied on those four routes in this
//      slice (the route file's own comment documents this: "the patient is the server-resolved job's
//      patient (resolved in the Drizzle service in prod)"). This file always uses the `org_admin` role for
//      those four routes — not a bug this file introduces, an existing, commented, Phase-1 gap.
//
// No universal-deny ABAC target-mapper bug (M20/M30-class: wrong id field name) was found in this module —
// every `getTarget` field name read by a route matches the field name its predicate reads
// (`supportConsentGrantId`, `tenantAccountId`, `flagKey`, `patientId`, `taskId`). Both TypeBox files
// (`platform-typebox.ts` / `tenant-typebox.ts`) self-register `uuid`/`date-time`/`email` in the
// `FormatRegistry` guarded by `FormatRegistry.Has(...)` checks — no missing-self-registration bug either.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import {
  type RouteRateLimit,
  TENANT_SLUG_AVAILABILITY_ROUTE_RATE_LIMIT,
  createRouteRateLimit,
} from "../src/bootstrap/plugins/route-rate-limit";
import {
  type TenantPlatformAbacResolver,
  type TenantPlatformRouteSeed,
  buildTenantPlatformAbacPredicates,
  createInMemoryTenantBackend,
  createInMemoryTenantPlatformBackend,
  createMemoryOrgProfile,
  createMemoryWizardRunner,
  createMemoryWizardState,
  createOnboardingWizard,
  memoryTask,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
// `TenantRouteSeed` is only exported from the tenant-routes barrel, not re-exported at the module root
// (unlike `TenantPlatformRouteSeed`, which the root index re-exports for the platform-ops surface).
import type { TenantRouteSeed } from "../src/modules/34-saas-tenant-platform/routes/tenant/index";

// ── header-auth shim (the M11/M28 precedent) ────────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-step-up"] === "fresh") {
    request.context.attributes.stepUpRecent = true;
  }
}

const ORG = "org_a";
const STUB_DB = {} as DbClient;

// ── fixture ids (uuid-shaped where a route's TypeBox schema requires `format: "uuid"`) ─────────────────
const TENANT_ACME_ID = "10000000-0000-4000-8000-000000000001";
const TENANT_DESTROY_ID = "10000000-0000-4000-8000-000000000002";
const GRANT_ID = "20000000-0000-4000-8000-000000000001";
const MEMBER_PLATFORM_OPS = "30000000-0000-4000-8000-000000000001";
// GAP-098 — the platform-ops tenant-export discovery list's fixtures.
const EXPORT_HELD_ID = "60000000-0000-4000-8000-000000000981";
const EXPORT_RELEASED_ID = "60000000-0000-4000-8000-000000000982";
const MEMBER_GRANTOR = "30000000-0000-4000-8000-000000000002";
const MEMBER_ORG_ADMIN = "30000000-0000-4000-8000-000000000003";
const INTENT_QUALIFY_ID = "40000000-0000-4000-8000-000000000001";
const INTENT_REJECT_ID = "40000000-0000-4000-8000-000000000002";
const DESTRUCTION_CERT_ID = "50000000-0000-4000-8000-000000000001";
const PATIENT_A = "60000000-0000-4000-8000-000000000001";
const PATIENT_B = "60000000-0000-4000-8000-000000000002";
const PATIENT_C = "60000000-0000-4000-8000-000000000003";
const TASK_START_ID = "70000000-0000-4000-8000-000000000001";
const TASK_BLOCK_ID = "70000000-0000-4000-8000-000000000002";
const BAA_TENANT_ID = "80000000-0000-4000-8000-000000000001";
const EXPORT_FULFILLED_ID = "90000000-0000-4000-8000-000000000001";
const TEST_FLAG_KEY = "m34.test_global_flag";
const NEW_FLAG_KEY = "m34.brand_new_flag";
const FOREIGN_TENANT_ORG = "a0000000-0000-4000-8000-000000000001";

// ── §4.5 permission seeds (the two authorized personas this file drives every 2xx route through) ───────
const PLATFORM_OPS_PERMISSIONS = [
  "tenant.list_platform",
  "tenant.read_platform",
  "tenant.provision",
  "tenant.transition_status",
  "tenant.offboard",
  "tenant.shred.execute",
  "tenant.dek_rotate",
  "tenant_invitation.list_platform",
  "tenant_invitation.issue",
  "tenant_invitation.revoke",
  "onboarding_template.list",
  "onboarding_template.write",
  "support_session.list_platform",
  "support_session.start",
  "support_session.elevate_phi_read",
  "support_session.close",
  "signup_intent.list_platform",
  "signup_intent.qualify",
  "tenant_export.list_platform",
  "platform_tenant_baa.read_platform",
  "platform_tenant_baa.write_platform",
  "feature_flag.read_platform",
  "feature_flag.write_platform",
  "feature_flag.kill_switch",
];
const ORG_ADMIN_PERMISSIONS = [
  "support_consent_grant.list_own",
  "support_consent_grant.issue",
  "support_consent_grant.revoke",
  "dsar_export.list_own",
  "dsar_export.request",
  "dsar_export.fulfill",
  "dsar_export.extend",
  "dsar_export.deny",
  "dsar_export.download",
  "tenant_export.list_own",
  "tenant_export.request",
  "tenant_export.download",
  "onboarding.read_own",
  "onboarding.update",
  "platform_tenant_baa.read_own",
  "platform_tenant_baa.attest",
];

/**
 * A small hand-rolled `TenantPlatformAbacResolver` — the fixed facts the eight §4.6 predicates need for
 * the specific grant/flag ids this file seeds/creates (the `fhir-inject.test.ts` `buildTestAbacResolver`
 * precedent). `loadOnboardingTask` is never reached (every onboarding-route test uses the `org_admin`
 * bypass arm), so it stays a deny-stub.
 */
function buildTestAbacResolver(): TenantPlatformAbacResolver {
  return {
    async hasActiveConsentedSupportSession({ tenantAccountId }) {
      return tenantAccountId === TENANT_ACME_ID;
    },
    async loadConsentGrant(_organizationId, grantId) {
      if (grantId !== GRANT_ID) return null;
      return {
        grantId,
        tenantAccountId: TENANT_ACME_ID,
        grantorMembershipId: MEMBER_GRANTOR,
        active: true,
      };
    },
    async loadFeatureFlag(_organizationId, flagKey, scopeOrganizationId = null) {
      // Exact-scope facts: the one seeded GLOBAL flag exists; any other (key, scope) is an ABSENT key in a
      // valid scope (first-time creation) — which only platform_ops may write.
      return {
        flagKey,
        organizationId: scopeOrganizationId,
        exists: flagKey === TEST_FLAG_KEY && scopeOrganizationId === null,
      };
    },
    async loadOnboardingTask() {
      return null;
    },
  };
}

function makeServer(
  options: { tenantBaseDomain?: string | null; slugAvailabilityRateLimit?: RouteRateLimit } = {},
) {
  const platformSeed: TenantPlatformRouteSeed = {
    // GAP-098 — one HELD bundle and one already-released job, so the `?held=true` filter has something
    // to include AND something to exclude (a filter proven only against an all-held set proves nothing).
    tenantExportJobs: [
      { id: EXPORT_HELD_ID, organizationId: ORG, held: true, heldBundleSizeBytes: "64424509440" },
      { id: EXPORT_RELEASED_ID, organizationId: ORG, held: false },
    ],
    tenants: [
      { id: TENANT_ACME_ID, orgSlug: "acme", legalBusinessName: "Acme Hospice", status: "active" },
      {
        id: TENANT_DESTROY_ID,
        orgSlug: "destroying-corp",
        legalBusinessName: "Destroying Corp",
        status: "destruction_pending",
      },
    ],
    consentGrants: [
      {
        id: GRANT_ID,
        organizationId: ORG,
        tenantAccountId: TENANT_ACME_ID,
        grantorMembershipId: MEMBER_GRANTOR,
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    ],
    signupIntents: [
      { id: INTENT_QUALIFY_ID, intentStatus: "new" },
      { id: INTENT_REJECT_ID, intentStatus: "new" },
    ],
  };
  const tenantSeed: TenantRouteSeed = {
    baaRecords: [
      {
        id: BAA_TENANT_ID,
        organizationId: ORG,
        tenantAccountId: TENANT_ACME_ID,
        addendumVersion: "v1",
        baaStatus: "pending",
      },
    ],
    tenantExportJobs: [
      {
        id: EXPORT_FULFILLED_ID,
        organizationId: ORG,
        status: "fulfilled",
        requestedPurpose: "migration",
      },
    ],
  };

  const platform = createInMemoryTenantPlatformBackend(platformSeed);
  const tenant = createInMemoryTenantBackend(tenantSeed);
  // The onboarding wizard (tenant surface): two org_admin-owned steps in sequence.
  const wizardState = createMemoryWizardState({
    tenants: [
      {
        tenantAccountId: TENANT_ACME_ID,
        organizationId: ORG,
        orgSlug: "acme",
        status: "onboarding",
        legalBusinessName: "Acme Hospice",
        complianceOfficerMembershipId: null,
      },
    ],
    templates: ["account_created", "verify_email"].map((key, i) => ({
      key,
      title: key,
      description: "",
      sequence: i + 1,
      owner: "org_admin" as const,
      completionMode: "attestation" as const,
      optional: false,
      canonical: true,
    })),
    tasks: [
      memoryTask(TENANT_ACME_ID, "account_created", "pending", { id: TASK_START_ID }),
      memoryTask(TENANT_ACME_ID, "verify_email", "pending", { id: TASK_BLOCK_ID }),
    ],
  });
  const wizard = createOnboardingWizard({
    activateOrganization: async () => undefined,
    runner: createMemoryWizardRunner(wizardState),
    orgProfile: createMemoryOrgProfile(wizardState),
  });

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "platform_ops_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: PLATFORM_OPS_PERMISSIONS,
        },
      ],
    },
    {
      orgId: ORG,
      userId: "org_admin_1",
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ORG_ADMIN_PERMISSIONS },
      ],
    },
    {
      orgId: ORG,
      userId: "reader_without_role_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["tenant.read_platform"],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "noperm_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent — the shared registry would otherwise
  // persist a predicate closed over a prior test's backend across the file).
  const reg = createPredicateRegistry();
  const resolver = buildTestAbacResolver();
  for (const [name, predicate] of Object.entries(
    buildTenantPlatformAbacPredicates({ resolver, isInCaseload: async () => false }),
  )) {
    reg.register(name, predicate);
  }
  // `step_up_recent` is M3's predicate (composed by every `requireStepUp` gate, not owned by M34); a
  // fresh registry starts without it, so a permissive test-local stand-in is registered here (the
  // fhir-inject.test.ts / M28 precedent for a composed-but-foreign predicate).
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountTenantPlatformRoutes(app, STUB_DB, {
    platform: { service: platform.service },
    tenant: { service: tenant.service },
    onboarding: { wizard },
    ...(options.tenantBaseDomain !== undefined
      ? { tenantBaseDomain: options.tenantBaseDomain }
      : {}),
    ...(options.slugAvailabilityRateLimit
      ? {
          slugAvailabilityRateLimit: createRouteRateLimit({
            store: createInMemoryRateLimitStore(),
            limit: options.slugAvailabilityRateLimit,
            keyPrefix: "m34-slug-availability-test",
          }),
        }
      : {}),
  });
  return { app, platform, tenant };
}

const PLATFORM_OPS = {
  "x-test-user": "platform_ops_1",
  "x-test-org": ORG,
  "x-test-roles": "platform_ops",
  "x-test-membership": MEMBER_PLATFORM_OPS,
};
const PLATFORM_OPS_STEPUP = { ...PLATFORM_OPS, "x-step-up": "fresh" };
// org_admin AND compliance_officer on one persona — a realistic tenant-side admin who is also the
// compliance officer of record (the `tenant_platform_baa_compliance_officer` + `support_consent_grant`
// issue-route spec note both name that persona explicitly).
const ORG_ADMIN = {
  "x-test-user": "org_admin_1",
  "x-test-org": ORG,
  "x-test-roles": "org_admin,compliance_officer",
  "x-test-membership": MEMBER_ORG_ADMIN,
};
const ORG_ADMIN_STEPUP = { ...ORG_ADMIN, "x-step-up": "fresh" };
const NOPERM = { "x-test-user": "noperm_1", "x-test-org": ORG, "x-test-roles": "none" };
// Holds `tenant.read_platform` (RBAC passes) but not the `platform_ops` role, so only the ABAC predicate can refuse it.
const READER_WITHOUT_ROLE = {
  "x-test-user": "reader_without_role_1",
  "x-test-org": ORG,
  "x-test-roles": "none",
  "x-test-membership": MEMBER_PLATFORM_OPS,
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

// ── auth gating — one 401 / one 403 / one 422 for the whole module ──────────────────────────────────────
describe("M34-saas-tenant-platform-inject — auth gating", () => {
  it("no auth headers at all → 401 (route: GET /api/v1/platform/tenants)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/platform/tenants" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("authenticated actor holding NO permissions → 403 (route: GET /api/v1/platform/tenants, requires tenant.list_platform)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants",
      headers: NOPERM,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a correctly-permissioned, stepped-up actor with an empty body → 422 VALIDATION_FAILED (route: POST /api/v1/platform/tenants)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants",
      headers: PLATFORM_OPS_STEPUP,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

// ── ADR-0049 D3: an operator-chosen slug is validated before anything is created ────────────────────
describe("M34-saas-tenant-platform-inject — provisioning slug (POST /api/v1/platform/tenants)", () => {
  const body = {
    legalBusinessName: "Sunrise Hospice",
    billingContactEmail: "billing@sunrise.test",
    breachNotificationContactEmail: "breach@sunrise.test",
    firstAdminEmail: "admin@sunrise.test",
    firstAdminFullName: "Ada Admin",
    planLabel: "standard",
  };
  const post = async (slug?: string) => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants",
      headers: PLATFORM_OPS_STEPUP,
      payload: slug === undefined ? body : { ...body, slug },
    });
    await app.close();
    return res;
  };

  it.each(["api", "xn--sunrise", "ab", "Sunrise", "-sunrise", "sun_rise"])(
    "refuses slug %s with 422 INVALID_TENANT_SLUG",
    async (slug) => {
      const res = await post(slug);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("INVALID_TENANT_SLUG");
    },
  );

  it("accepts a valid slug", async () => {
    expect((await post("sunrise")).statusCode).toBe(202);
  });

  // Slice 5 (G5): the plan is chosen at onboarding step 2 (a census-banded contract), so provisioning no longer needs the retired
  // flat tier. An omitted `planLabel` is stored as the honest placeholder "unassigned", never as a tier nobody picked.
  it("provisions without a planLabel and stores the placeholder 'unassigned'", async () => {
    const { app } = makeServer();
    const { planLabel: _omitted, ...withoutPlan } = body;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants",
      headers: PLATFORM_OPS_STEPUP,
      payload: { ...withoutPlan, slug: "sunrise" },
    });
    expect(res.statusCode).toBe(202);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants?search=Sunrise",
      headers: PLATFORM_OPS,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: { planLabel: string }) => t.planLabel)).toEqual([
      "unassigned",
    ]);
    await app.close();
  });

  it("still refuses a planLabel that is not one of the known labels", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants",
      headers: PLATFORM_OPS_STEPUP,
      payload: { ...body, slug: "sunrise", planLabel: "platinum" },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── slug availability (GET /api/v1/platform/tenant-slugs/:slug/availability) ─────────────────────────
describe("M34-saas-tenant-platform-inject — tenant slug availability", () => {
  const check = async (
    slug: string,
    opts: { headers?: Record<string, string>; tenantBaseDomain?: string | null } = {},
  ) => {
    const { app } = makeServer(
      opts.tenantBaseDomain === undefined ? {} : { tenantBaseDomain: opts.tenantBaseDomain },
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/platform/tenant-slugs/${slug}/availability`,
      headers: opts.headers ?? PLATFORM_OPS,
    });
    await app.close();
    return res;
  };

  it("401 without a session and 403 without tenant.read_platform", async () => {
    expect((await check("sunrise", { headers: {} })).statusCode).toBe(401);
    expect((await check("sunrise", { headers: NOPERM })).statusCode).toBe(403);
  });

  it("403 when the permission is held but the tenant_lifecycle_platform_ops ABAC predicate denies (no platform_ops role)", async () => {
    const { app, platform } = makeServer();
    const lookup = vi.spyOn(platform.service, "isTenantSlugTaken");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-slugs/sunrise/availability",
      headers: READER_WITHOUT_ROLE,
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a free, valid slug is available and carries its address when a base domain is set", async () => {
    const res = await check("sunrise", { tenantBaseDomain: "chartwarden.cloud" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      slug: "sunrise",
      valid: true,
      available: true,
      url: "https://sunrise.chartwarden.cloud",
    });
  });

  it("answers without a url in single-host mode (no base domain)", async () => {
    const res = await check("sunrise");

    expect(res.json()).toEqual({ slug: "sunrise", valid: true, available: true });
  });

  it("a slug an organization already holds is valid but not available", async () => {
    const res = await check("acme");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      slug: "acme",
      valid: true,
      available: false,
      reason: "taken",
    });
  });

  it.each([
    ["admin", "reserved"],
    ["app", "reserved"],
    ["ab", "format"],
    ["Sunrise", "format"],
    ["sun_rise", "format"],
    ["xn--sunrise", "punycode"],
    ["x".repeat(64), "format"],
  ])("refuses %s as invalid (%s) without consulting the data", async (slug, reason) => {
    const res = await check(slug, { tenantBaseDomain: "chartwarden.cloud" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slug, valid: false, available: false, reason });
  });

  it("never calls the taken-lookup for a reserved, malformed or punycode slug, but does for a valid one", async () => {
    const { app, platform } = makeServer();
    const lookup = vi.spyOn(platform.service, "isTenantSlugTaken");
    const probe = (slug: string) =>
      app.inject({
        method: "GET",
        url: `/api/v1/platform/tenant-slugs/${slug}/availability`,
        headers: PLATFORM_OPS,
      });

    for (const refused of ["admin", "wardenx", "ab", "Sunrise", "sun_rise", "xn--sunrise"]) {
      expect((await probe(refused)).json().valid).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();

    expect((await probe("sunrise")).json().valid).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("sunrise");
    await app.close();
  });

  describe("per-route rate limit (a probe is an audited platform read)", () => {
    const TWO_PER_MINUTE: RouteRateLimit = {
      perUser: 2,
      perOrg: 100,
      windowMs: 60_000,
      failMode: "open",
    };
    const probe = (app: ReturnType<typeof makeServer>["app"], headers: Record<string, string>) =>
      app.inject({
        method: "GET",
        url: "/api/v1/platform/tenant-slugs/sunrise/availability",
        headers,
      });

    it("answers 429 RATE_LIMITED with Retry-After once a user is over the cap", async () => {
      const { app } = makeServer({ slugAvailabilityRateLimit: TWO_PER_MINUTE });

      const first = await probe(app, PLATFORM_OPS);
      const second = await probe(app, PLATFORM_OPS);
      const third = await probe(app, PLATFORM_OPS);
      await app.close();

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe("RATE_LIMITED");
      expect(third.headers["retry-after"]).toBe("60");
    });

    it("is not spent by callers the permission or ABAC gate refuses", async () => {
      const { app } = makeServer({ slugAvailabilityRateLimit: TWO_PER_MINUTE });

      for (let i = 0; i < 5; i++) {
        expect((await probe(app, READER_WITHOUT_ROLE)).statusCode).toBe(403);
        expect((await probe(app, NOPERM)).statusCode).toBe(403);
      }
      const allowed = await probe(app, PLATFORM_OPS);
      await app.close();

      expect(allowed.statusCode).toBe(200);
    });

    it("the composition root builds the limiter from the shipped budget and mounts it on the platform routes", () => {
      const root = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

      expect(root).toMatch(
        /slugAvailabilityRateLimit: createRouteRateLimit\(\{[^}]*limit: TENANT_SLUG_AVAILABILITY_ROUTE_RATE_LIMIT/s,
      );
    });

    it("the shipped budget is 30 per minute per user and fails open (an availability control, not a probing oracle)", () => {
      expect(TENANT_SLUG_AVAILABILITY_ROUTE_RATE_LIMIT).toMatchObject({
        perUser: 30,
        windowMs: 60_000,
        failMode: "open",
      });
    });
  });
});

// ── platform-ops: tenants.ts (7 routes) ──────────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — platform-ops tenant lifecycle (tenants.ts)", () => {
  it("list, provision, read overview, transition status, offboard, shred, dek-rotate", async () => {
    const { app } = makeServer();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants",
      headers: PLATFORM_OPS,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(2);

    const provision = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants",
      headers: PLATFORM_OPS_STEPUP,
      payload: {
        legalBusinessName: "New Prospect Hospice",
        billingContactEmail: "billing@prospect.example.org",
        breachNotificationContactEmail: "breach@prospect.example.org",
        firstAdminEmail: "admin@prospect.example.org",
        firstAdminFullName: "Prospect Administrator",
        planLabel: "standard",
      },
    });
    expect(provision.statusCode).toBe(202);
    expect(provision.json().tenantAccountId).toBeTypeOf("string");

    const overview = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants/acme",
      headers: PLATFORM_OPS,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().orgSlug).toBe("acme");

    const status = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants/acme/status",
      headers: PLATFORM_OPS_STEPUP,
      payload: { toStatus: "suspended", transitionReason: "billing dispute under review" },
    });
    expect(status.statusCode).toBe(202);
    expect(status.json().status).toBe("suspended");

    const offboard = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants/acme/offboard",
      headers: PLATFORM_OPS_STEPUP,
      payload: {
        transitionReason: "contract terminated at renewal",
        exportPurpose: "baa_termination",
      },
    });
    expect(offboard.statusCode).toBe(202);
    expect(offboard.json().status).toBe("offboarding_initiated");

    const shred = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants/destroying-corp/shred",
      headers: PLATFORM_OPS_STEPUP,
      payload: {
        transitionReason: "retention window elapsed, cert approved",
        destructionCertificateId: DESTRUCTION_CERT_ID,
      },
    });
    expect(shred.statusCode).toBe(202);
    expect(shred.json().jobId).toBeTypeOf("string");

    const dekRotate = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenants/acme/dek-rotate",
      headers: PLATFORM_OPS_STEPUP,
      payload: { reason: "scheduled annual key rotation" },
    });
    expect(dekRotate.statusCode).toBe(202);
    expect(dekRotate.json().jobId).toBeTypeOf("string");

    await app.close();
  });
});

// ── platform-ops: tenant-invitations.ts (3 routes) ───────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — platform → first-admin invitations", () => {
  it("list, issue, revoke", async () => {
    const { app } = makeServer();

    const list0 = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-invitations",
      headers: PLATFORM_OPS,
    });
    expect(list0.statusCode).toBe(200);

    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/platform/tenant-invitations",
      headers: PLATFORM_OPS_STEPUP,
      payload: { orgSlug: "acme", firstAdminEmail: "first-admin@acme.example.org" },
    });
    expect(issue.statusCode).toBe(201);
    const invitationId = issue.json().id as string;

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/platform/tenant-invitations/${invitationId}`,
      headers: PLATFORM_OPS,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe("revoked");

    await app.close();
  });

  // Slice 5 (G3): the wizard's "first admin" step reads ONE tenant's invitations in a single call. The list used to be global, so the
  // admin console paged every tenant's invitations client-side to find its own.
  it("narrows the list to one tenant with ?tenantAccountId", async () => {
    const { app } = makeServer();
    const issue = (orgSlug: string, email: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/platform/tenant-invitations",
        headers: PLATFORM_OPS_STEPUP,
        payload: { orgSlug, firstAdminEmail: email },
      });
    expect((await issue("acme", "first@acme.example.org")).statusCode).toBe(201);
    expect((await issue("destroying-corp", "first@destroying.example.org")).statusCode).toBe(201);

    const all = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-invitations",
      headers: PLATFORM_OPS,
    });
    expect(all.json().items).toHaveLength(2);

    const acme = await app.inject({
      method: "GET",
      url: `/api/v1/platform/tenant-invitations?tenantAccountId=${TENANT_ACME_ID}`,
      headers: PLATFORM_OPS,
    });
    expect(acme.statusCode).toBe(200);
    expect(acme.json().items.map((i: { tenantAccountId: string }) => i.tenantAccountId)).toEqual([
      TENANT_ACME_ID,
    ]);

    const stranger = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-invitations?tenantAccountId=99999999-9999-4999-8999-999999999999",
      headers: PLATFORM_OPS,
    });
    expect(stranger.statusCode).toBe(200);
    expect(stranger.json().items).toEqual([]);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-invitations?tenantAccountId=not-a-uuid",
      headers: PLATFORM_OPS,
    });
    expect(malformed.statusCode).toBe(422);
    await app.close();
  });
});

// ── platform-ops: key-ring.ts (1 route) ──────────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — key-ring metadata (§3.5)", () => {
  it("reads the metadata-only key-ring view for a tenant", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenants/acme/key-ring",
      headers: PLATFORM_OPS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentDekVersion).toBe("v1");
    await app.close();
  });
});

// ── platform-ops: onboarding-templates.ts (2 routes) ─────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — onboarding-template catalog", () => {
  it("lists then adds a non-canonical template", async () => {
    const { app } = makeServer();

    const list0 = await app.inject({
      method: "GET",
      url: "/api/v1/platform/onboarding-templates",
      headers: PLATFORM_OPS,
    });
    expect(list0.statusCode).toBe(200);

    const write = await app.inject({
      method: "POST",
      url: "/api/v1/platform/onboarding-templates",
      headers: PLATFORM_OPS_STEPUP,
      payload: { key: "custom_step", title: "Custom Onboarding Step", canonicalOrder: 5 },
    });
    expect(write.statusCode).toBe(201);
    expect(write.json().key).toBe("custom_step");

    await app.close();
  });
});

// ── platform-ops: support-sessions.ts (5 routes) ─────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — tenant-consented support sessions (F01/D8/D16)", () => {
  it("starts a session against a consent grant, elevates, lists, reads events, and closes it", async () => {
    const { app } = makeServer();

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/platform/support-sessions",
      headers: PLATFORM_OPS_STEPUP,
      payload: { supportConsentGrantId: GRANT_ID },
    });
    expect(start.statusCode).toBe(201);
    const sessionId = start.json().sessionId as string;

    const elevate = await app.inject({
      method: "POST",
      url: `/api/v1/platform/support-sessions/${sessionId}/elevate?tenantAccountId=${TENANT_ACME_ID}`,
      headers: PLATFORM_OPS_STEPUP,
      payload: {},
    });
    expect(elevate.statusCode).toBe(201);
    expect(elevate.json().elevationExpiresAt).toBeTypeOf("string");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform/support-sessions",
      headers: PLATFORM_OPS,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((s: { id: string }) => s.id)).toContain(sessionId);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/platform/support-sessions/${sessionId}/events`,
      headers: PLATFORM_OPS,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items.length).toBeGreaterThanOrEqual(2); // session.start + session.elevate

    const close = await app.inject({
      method: "POST",
      url: `/api/v1/platform/support-sessions/${sessionId}/close`,
      headers: PLATFORM_OPS,
      payload: {},
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().closeReason).toBe("manual");

    await app.close();
  });
});

// ── platform-ops: signup-intents.ts (3 routes) ───────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — platform-ops signup-intent triage queue", () => {
  it("lists, qualifies one intent, rejects another", async () => {
    const { app } = makeServer();

    const list0 = await app.inject({
      method: "GET",
      url: "/api/v1/platform/signup-intents",
      headers: PLATFORM_OPS,
    });
    expect(list0.statusCode).toBe(200);

    const qualify = await app.inject({
      method: "POST",
      url: `/api/v1/platform/signup-intents/${INTENT_QUALIFY_ID}/qualify`,
      headers: PLATFORM_OPS,
      payload: { planLabel: "standard", firstAdminFullName: "Qualified Administrator" },
    });
    expect(qualify.statusCode).toBe(202);
    expect(qualify.json().intentStatus).toBe("qualified");

    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/platform/signup-intents/${INTENT_REJECT_ID}/reject`,
      headers: PLATFORM_OPS,
      payload: { rejectionReason: "did not meet minimum bed-count threshold" },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().intentStatus).toBe("rejected");

    await app.close();
  });
});

// ── platform-ops: baa-register.ts (3 routes) ─────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — platform→tenant BAA register (§3.8/D11)", () => {
  it("lists, creates, and updates a BAA record", async () => {
    const { app } = makeServer();

    const list0 = await app.inject({
      method: "GET",
      url: "/api/v1/platform/baa-register",
      headers: PLATFORM_OPS,
    });
    expect(list0.statusCode).toBe(200);

    // A register WRITE is a decision: it needs the write key AND a fresh step-up (the read key alone is not enough).
    const payload = {
      tenantAccountId: TENANT_ACME_ID,
      addendumVersion: "v2",
      baaStatus: "pending",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/platform/baa-register",
          headers: PLATFORM_OPS,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/platform/baa-register",
      headers: PLATFORM_OPS_STEPUP,
      payload,
    });
    expect(create.statusCode).toBe(201);
    const baaId = create.json().id as string;

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/platform/baa-register/${baaId}`,
          headers: PLATFORM_OPS,
          payload: { baaStatus: "executed" },
        })
      ).statusCode,
    ).toBe(403);
    // An executed BAA must point at its executed document (422 BAA_DOCUMENT_REQUIRED), on create and on update.
    const noDocument = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/baa-register/${baaId}`,
      headers: PLATFORM_OPS_STEPUP,
      payload: { baaStatus: "executed" },
    });
    expect(noDocument.statusCode).toBe(422);
    expect(noDocument.json().error.code).toBe("BAA_DOCUMENT_REQUIRED");
    const createExecutedNoDocument = await app.inject({
      method: "POST",
      url: "/api/v1/platform/baa-register",
      headers: PLATFORM_OPS_STEPUP,
      payload: { ...payload, addendumVersion: "v-doc-less", baaStatus: "executed" },
    });
    expect(createExecutedNoDocument.statusCode).toBe(422);
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/baa-register/${baaId}`,
      headers: PLATFORM_OPS_STEPUP,
      payload: { baaStatus: "executed", documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0004" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().baaStatus).toBe("executed");
    expect(update.json().documentId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0004");

    await app.close();
  });
});

// ── platform-ops: feature-flags-admin.ts (3 routes) ──────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — feature-flag admin (§4.7/D13)", () => {
  it("upserts a global flag, lists it, then toggles the kill switch", async () => {
    const { app } = makeServer();

    const upsert = await app.inject({
      method: "POST",
      url: "/api/v1/platform/feature-flags",
      headers: PLATFORM_OPS_STEPUP,
      payload: { flagKey: TEST_FLAG_KEY, flagKind: "product", valueType: "bool", value: true },
    });
    expect(upsert.statusCode).toBe(201);
    expect(upsert.json().organizationId).toBeNull();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/platform/feature-flags",
      headers: PLATFORM_OPS,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((f: { flagKey: string }) => f.flagKey)).toContain(TEST_FLAG_KEY);

    const kill = await app.inject({
      method: "POST",
      url: `/api/v1/platform/feature-flags/${TEST_FLAG_KEY}/kill-switch`,
      headers: PLATFORM_OPS_STEPUP,
      payload: { killSwitchActive: true },
    });
    expect(kill.statusCode).toBe(200);
    expect(kill.json().killSwitchActive).toBe(true);

    await app.close();
  });
});

describe("M34-saas-tenant-platform-inject — feature-flag scope + first-time creation (§4.6/§4.7)", () => {
  it("platform_ops creates a brand-new GLOBAL flag key (no pre-existing row to resolve)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/feature-flags",
      headers: PLATFORM_OPS_STEPUP,
      payload: { flagKey: NEW_FLAG_KEY, flagKind: "product", valueType: "bool", value: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().organizationId).toBeNull();
    await app.close();
  });

  it("platform_ops kills a per-tenant flag in ANOTHER org via the body's organizationId, leaving the global row alone", async () => {
    const { app } = makeServer();
    for (const organizationId of [null, FOREIGN_TENANT_ORG]) {
      const up = await app.inject({
        method: "POST",
        url: "/api/v1/platform/feature-flags",
        headers: PLATFORM_OPS_STEPUP,
        payload: {
          flagKey: NEW_FLAG_KEY,
          organizationId,
          flagKind: "kill_switch",
          valueType: "bool",
          value: true,
        },
      });
      expect(up.statusCode).toBe(201);
    }
    const kill = await app.inject({
      method: "POST",
      url: `/api/v1/platform/feature-flags/${NEW_FLAG_KEY}/kill-switch`,
      headers: PLATFORM_OPS_STEPUP,
      payload: { killSwitchActive: true, organizationId: FOREIGN_TENANT_ORG },
    });
    expect(kill.statusCode).toBe(200);
    expect(kill.json().organizationId).toBe(FOREIGN_TENANT_ORG);
    expect(kill.json().killSwitchActive).toBe(true);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/platform/feature-flags",
      headers: PLATFORM_OPS,
    });
    const globalRow = listed
      .json()
      .items.find(
        (f: { flagKey: string; organizationId: string | null }) =>
          f.flagKey === NEW_FLAG_KEY && f.organizationId === null,
      );
    expect(globalRow.killSwitchActive).toBe(false);
    await app.close();
  });

  it("the kill switch on a key with no row at that scope is a 404, not a create", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/platform/feature-flags/${NEW_FLAG_KEY}/kill-switch`,
      headers: PLATFORM_OPS_STEPUP,
      payload: { killSwitchActive: true },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── tenant: support-consent-grants.ts (3 routes) ─────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — tenant support-consent grants", () => {
  it("lists, issues, and revokes a grant", async () => {
    const { app } = makeServer();

    const list0 = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/support-consent-grants",
      headers: ORG_ADMIN,
    });
    expect(list0.statusCode).toBe(200);

    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/tenant/support-consent-grants",
      headers: ORG_ADMIN_STEPUP,
      payload: {
        scope: "organization_scoped",
        grantReason: "platform support engaged to diagnose a billing sync defect",
        expiresAtIsoOffsetHours: 24,
      },
    });
    expect(issue.statusCode).toBe(201);
    const grantId = issue.json().id as string;

    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/support-consent-grants/${grantId}/revoke`,
      headers: ORG_ADMIN,
      payload: { revocationReason: "issue resolved ahead of schedule" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().active).toBe(false);

    await app.close();
  });
});

// ── tenant: dsar-export-jobs.ts (6 routes) ───────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — HIPAA §164.524 DSAR export jobs", () => {
  it("requests three jobs, then list / fulfill+download / extend / deny each exercise the remaining routes", async () => {
    const { app } = makeServer();

    const requestJob = async (patientId: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tenant/dsar-export-jobs",
        headers: ORG_ADMIN,
        payload: {
          patientId,
          requestSource: "patient",
          requestorIdentityVerificationEvidence:
            "government id verified in person by the front-desk RN",
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };

    const jobA = await requestJob(PATIENT_A);
    const jobB = await requestJob(PATIENT_B);
    const jobC = await requestJob(PATIENT_C);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/dsar-export-jobs",
      headers: ORG_ADMIN,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(3);

    const fulfill = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/dsar-export-jobs/${jobA}/fulfill`,
      headers: ORG_ADMIN_STEPUP,
      payload: {},
    });
    expect(fulfill.statusCode).toBe(200);
    expect(fulfill.json().status).toBe("fulfilled");

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/tenant/dsar-export-jobs/${jobA}/download`,
      headers: ORG_ADMIN,
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().url).toBeTypeOf("string");

    const extend = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/dsar-export-jobs/${jobB}/extend`,
      headers: ORG_ADMIN,
      payload: {},
    });
    expect(extend.statusCode).toBe(200);
    expect(extend.json().status).toBe("extended");

    const deny = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/dsar-export-jobs/${jobC}/deny`,
      headers: ORG_ADMIN_STEPUP,
      payload: {
        deniedReason: "psychotherapy_notes",
        narrative: "the requested notes are excluded under §164.524(a)(1)",
      },
    });
    expect(deny.statusCode).toBe(200);
    expect(deny.json().status).toBe("denied");

    await app.close();
  });
});

// ── tenant: tenant-export-jobs.ts (3 routes) ─────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — tenant export jobs", () => {
  it("requests a new export, lists the queue, and downloads a pre-fulfilled seeded bundle", async () => {
    const { app } = makeServer();

    const request = await app.inject({
      method: "POST",
      url: "/api/v1/tenant/tenant-export-jobs",
      headers: ORG_ADMIN_STEPUP,
      payload: {
        requestedPurpose: "migration",
        justification: "migrating to a new practice-management stack",
      },
    });
    expect(request.statusCode).toBe(201);
    expect(request.json().status).toBe("requested");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/tenant-export-jobs",
      headers: ORG_ADMIN,
    });
    expect(list.statusCode).toBe(200);

    // downloads the seeded, already-`fulfilled` job (the freshly-requested one above is still `requested`
    // and would 409 — `tenantExportDownloadUrl` requires `status === "fulfilled"`).
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/tenant/tenant-export-jobs/${EXPORT_FULFILLED_ID}/download`,
      headers: ORG_ADMIN_STEPUP,
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().url).toBeTypeOf("string");

    await app.close();
  });
});

// ── platform: tenant-export-approval.ts — the GAP-098 discovery list ─────────────────────────────────
describe("M34-saas-tenant-platform-inject — platform-ops tenant-export discovery (GAP-098)", () => {
  it("no auth headers → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/platform/tenant-export-jobs" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("an actor without tenant_export.list_platform → 403", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-export-jobs",
      headers: NOPERM,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("holding the key WITHOUT the platform_ops role → 403", async () => {
    // The conjunct that matters on a cross-tenant surface: `tenant_lifecycle_platform_ops`. A tenant
    // admin who acquired the permission key must not be able to enumerate every tenant's exports.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-export-jobs",
      headers: { ...ORG_ADMIN, "x-test-roles": "org_admin" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lists every export job for a platform operator", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-export-jobs",
      headers: PLATFORM_OPS,
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((j: { id: string }) => j.id);
    expect(ids).toContain(EXPORT_HELD_ID);
    expect(ids).toContain(EXPORT_RELEASED_ID);
    await app.close();
  });

  it("?held=true narrows to the bundles awaiting a co-sign, with the size to decide on", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-export-jobs?held=true",
      headers: PLATFORM_OPS,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as {
      id: string;
      heldForOversizedApproval: boolean;
      heldBundleSizeBytes: string | null;
    }[];
    expect(items.map((j) => j.id)).toEqual([EXPORT_HELD_ID]);
    expect(items[0]?.heldForOversizedApproval).toBe(true);
    // A string, never a number — an oversized bundle is past 2^31 by definition (GAP-097).
    expect(items[0]?.heldBundleSizeBytes).toBe("64424509440");
    await app.close();
  });

  it("?held=false is a real filter, not a no-op", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-export-jobs?held=false",
      headers: PLATFORM_OPS,
    });
    expect(res.json().items.map((j: { id: string }) => j.id)).toEqual([EXPORT_RELEASED_ID]);
    await app.close();
  });

  it("rejects a malformed limit rather than silently clamping the query", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/tenant-export-jobs?limit=999",
      headers: PLATFORM_OPS,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── tenant: onboarding-tasks.ts (4 routes) ───────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — tenant onboarding checklist (D3)", () => {
  it("reads own onboarding state, starts + completes one task, blocks another", async () => {
    const { app } = makeServer();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/tenant/onboarding",
      headers: ORG_ADMIN,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(2);

    const start = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${TASK_START_ID}/start`,
      headers: ORG_ADMIN,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().status).toBe("in_progress");

    // The deprecated /complete is the attest route: evidence is required.
    const noEvidence = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${TASK_START_ID}/complete`,
      headers: ORG_ADMIN,
      payload: {},
    });
    expect(noEvidence.statusCode).toBe(422);
    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${TASK_START_ID}/complete`,
      headers: ORG_ADMIN,
      payload: { evidenceNote: "administrator confirmed the account details" },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("done");

    const block = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${TASK_BLOCK_ID}/block`,
      headers: ORG_ADMIN,
      payload: { blockerReason: "waiting on the tenant's IT team to whitelist our SMTP relay" },
    });
    expect(block.statusCode).toBe(200);
    expect(block.json().status).toBe("blocked");

    await app.close();
  });
});

// ── tenant: baa.ts (2 routes) ─────────────────────────────────────────────────────────────────────────
describe("M34-saas-tenant-platform-inject — tenant's own platform-BAA history", () => {
  it("reads the tenant's BAA history and the compliance officer attests one record", async () => {
    const { app } = makeServer();

    const list = await app.inject({ method: "GET", url: "/api/v1/tenant/baa", headers: ORG_ADMIN });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(1);

    const attest = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/baa/${BAA_TENANT_ID}/attest`,
      headers: ORG_ADMIN_STEPUP,
      payload: { attestationConfirmed: true },
    });
    expect(attest.statusCode).toBe(200);
    expect(attest.json().attestedAt).toBeTypeOf("string");

    await app.close();
  });
});

// ── public: signup-intents.ts (3 routes) — ALWAYS 503, documented Phase-1 posture, not a gap ────────────
describe("M34-saas-tenant-platform-inject — public self-serve signup surface: 503 by design", () => {
  it("all three public routes answer 503 SIGNUP_DISABLED (no signupGate injected by mountTenantPlatformRoutes; D14 deny-default)", async () => {
    const { app } = makeServer();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/public/signup-intents",
      payload: {},
    });
    expect(create.statusCode).toBe(503);
    expect(create.json().error.code).toBe("SIGNUP_DISABLED");

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/public/signup-intents/some-token-hash/verify-email",
      payload: {},
    });
    expect(verify.statusCode).toBe(503);
    expect(verify.json().error.code).toBe("SIGNUP_DISABLED");

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/public/tenant-invitations/${"a".repeat(43)}/accept`,
      payload: {},
    });
    expect(accept.statusCode).toBe(503);
    expect(accept.json().error.code).toBe("SIGNUP_DISABLED");

    await app.close();
  });
});
