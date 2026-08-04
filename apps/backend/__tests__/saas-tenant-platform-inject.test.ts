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
} from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type TenantPlatformAbacResolver,
  type TenantPlatformRouteSeed,
  buildTenantPlatformAbacPredicates,
  createInMemoryTenantBackend,
  createInMemoryTenantPlatformBackend,
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
  "platform_tenant_baa.read_platform",
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
    async loadFeatureFlag(_organizationId, flagKey) {
      if (flagKey !== TEST_FLAG_KEY) return null;
      return { flagKey, organizationId: null }; // a PLATFORM-scoped (global) flag — platform_ops only.
    },
    async loadOnboardingTask() {
      return null;
    },
  };
}

function makeServer() {
  const platformSeed: TenantPlatformRouteSeed = {
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
    onboardingTasks: [
      { id: TASK_START_ID, organizationId: ORG, templateKey: "account_created", status: "pending" },
      { id: TASK_BLOCK_ID, organizationId: ORG, templateKey: "verify_email", status: "pending" },
    ],
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
      payload: { planLabel: "standard" },
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

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/platform/baa-register",
      headers: PLATFORM_OPS,
      payload: { tenantAccountId: TENANT_ACME_ID, addendumVersion: "v2", baaStatus: "pending" },
    });
    expect(create.statusCode).toBe(201);
    const baaId = create.json().id as string;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/platform/baa-register/${baaId}`,
      headers: PLATFORM_OPS,
      payload: { baaStatus: "executed" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().baaStatus).toBe("executed");

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
      payload: { flagKey: TEST_FLAG_KEY, flagKind: "product", valueType: "boolean", value: true },
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

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/tenant/onboarding/${TASK_START_ID}/complete`,
      headers: ORG_ADMIN,
      payload: {},
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
      url: "/api/v1/public/tenant-invitations/some-token-hash/accept",
      payload: {},
    });
    expect(accept.statusCode).toBe(503);
    expect(accept.json().error.code).toBe("SIGNUP_DISABLED");

    await app.close();
  });
});
