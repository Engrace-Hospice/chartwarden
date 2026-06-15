// apps/backend/__tests__/authz-idor.test.ts — M3-T11 IDOR suite (M3 spec §9.3; the STRIDE
// "I — IDOR" row of M3_STRIDE_THREAT_MODEL.md).
//
// §9.3: "every object-level endpoint enumerated as an unauthorized actor → 404/403; no
// existence leak." This exercises M3's object-level routes through the FULL M1 middleware
// chain + the REAL Authorization Contract (same harness as authz-routes.test.ts), asserting:
//
//   • An actor LACKING an endpoint's meta-permission gets 403 — and the SAME 403 whether the
//     target id exists or not (the permission gate precedes the object lookup, so existence is
//     never disclosed to an unauthorized actor).
//   • Only an actor WITH the permission can distinguish present (2xx) from absent (404) — the
//     §9.3 "404/403 disambiguation correct" property.
//
// Cross-tenant object isolation (a tenant-B actor using a tenant-A id) is enforced by RLS
// keyed on app.org_id (migration 0009), proven behaviourally in
// packages/db/migrations/__tests__/authz-rls-isolation.test.ts — not re-asserted against the
// in-memory stores here, which carry no RLS.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import {
  type AuthzRouteDeps,
  createFixedPermissionResolver,
  createInMemoryAuditorSessionMinter,
  createInMemoryBreakGlassStore,
  createInMemoryComplianceNotifier,
  createInMemoryEngagementStore,
  createInMemoryMembershipRoleStore,
  createInMemoryRoleStore,
  registerAuthorizationRoutes,
} from "../src/modules/03-authorization/index";

/** Test-only auth shim: populate request.context from headers (mirrors authz-routes.test). */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const PERMISSION_SEED = [
  {
    organizationId: "org_a",
    userId: "admin_1",
    permissions: ["role.read", "role.manage", "role.assign"],
  },
  {
    organizationId: "org_a",
    userId: "co_1",
    permissions: ["breakglass.read", "breakglass.cosign", "engagement.manage", "engagement.read"],
  },
  // The "unauthorized actor": holds only breakglass.invoke — lacks every object-level
  // endpoint's gating meta-permission below.
  { organizationId: "org_a", userId: "rn_1", permissions: ["breakglass.invoke"] },
];

function makeServer() {
  const roles = createInMemoryRoleStore();
  const membershipRoles = createInMemoryMembershipRoleStore();
  const breakGlass = createInMemoryBreakGlassStore();
  const engagements = createInMemoryEngagementStore();
  const auditorSessions = createInMemoryAuditorSessionMinter();
  const notifier = createInMemoryComplianceNotifier();
  const perms = createFixedPermissionResolver(PERMISSION_SEED);
  const auditSink = createInMemoryAuditExecutor();

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: s.organizationId,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const deps: AuthzRouteDeps = {
    roles: roles.store,
    membershipRoles: membershipRoles.store,
    breakGlass: breakGlass.store,
    engagements: engagements.store,
    auditorSessions: auditorSessions.minter,
    notifier: notifier.notifier,
    effectivePermissions: perms.resolver,
    audit: auditSink.executor,
  };
  registerAuthorizationRoutes(app, deps);
  return app;
}

const ADMIN = { "x-test-user": "admin_1", "x-test-org": "org_a", "x-test-roles": "org_admin" };
const COMPLIANCE = { "x-test-user": "co_1", "x-test-org": "org_a", "x-test-roles": "compliance" };
const UNAUTH = { "x-test-user": "rn_1", "x-test-org": "org_a", "x-test-roles": "clinical_rn" };

const MISSING = "00000000-0000-0000-0000-000000000000"; // a syntactically valid, absent id

/**
 * Every object-level M3 endpoint + the meta-permission it gates on. The UNAUTH actor (rn_1)
 * holds none of these, so each must answer 403 regardless of whether the target exists.
 */
const OBJECT_ENDPOINTS: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string }> = [
  { method: "PATCH", url: `/api/v1/roles/${MISSING}` },
  { method: "DELETE", url: `/api/v1/roles/${MISSING}` },
  { method: "GET", url: `/api/v1/memberships/${MISSING}/roles` },
  { method: "POST", url: `/api/v1/memberships/${MISSING}/roles` },
  { method: "DELETE", url: `/api/v1/memberships/${MISSING}/roles/${MISSING}` },
  { method: "POST", url: `/api/v1/breakglass/${MISSING}/cosign` },
  { method: "POST", url: `/api/v1/breakglass/${MISSING}/revoke` },
  { method: "PATCH", url: `/api/v1/engagements/${MISSING}` },
  { method: "POST", url: `/api/v1/engagements/${MISSING}/auditors` },
  { method: "GET", url: `/api/v1/engagements/${MISSING}/summary` },
];

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M3-T11 IDOR suite (§9.3) — object-level endpoints", () => {
  describe.each(OBJECT_ENDPOINTS)("$method $url", ({ method, url }) => {
    it("an actor without the gating meta-permission → 403 (no object lookup, no leak)", async () => {
      const app = makeServer();
      const res = await app.inject({ method, url, headers: UNAUTH });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("unauthenticated → 401 envelope (deny before any object lookup)", async () => {
      const app = makeServer();
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("no existence leak: the 403 is identical whether the object exists or not", () => {
    it("PATCH /roles/:id — unauthorized actor gets 403 for an EXISTING and a MISSING id alike", async () => {
      const app = makeServer();
      const onExisting = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/tmpl_medical_director", // a seeded system_locked template
        headers: UNAUTH,
        payload: { name: "x" },
      });
      const onMissing = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${MISSING}`,
        headers: UNAUTH,
        payload: { name: "x" },
      });
      expect(onExisting.statusCode).toBe(403);
      expect(onMissing.statusCode).toBe(403); // same code → existence not disclosed
      await app.close();
    });

    it("only an AUTHORIZED actor can distinguish present (2xx) from absent (404)", async () => {
      const app = makeServer();
      const present = await app.inject({
        method: "PATCH",
        url: "/api/v1/roles/tmpl_medical_director",
        headers: ADMIN,
        payload: { name: "Site Medical Director" },
      });
      const absent = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${MISSING}`,
        headers: ADMIN,
        payload: { name: "x" },
      });
      expect(present.statusCode).toBe(200);
      expect(absent.statusCode).toBe(404);
      expect(absent.json().error.code).toBe("NOT_FOUND");
      await app.close();
    });
  });

  describe("404 disambiguation: authorized actor + absent object → 404 NOT_FOUND", () => {
    it("POST /breakglass/:id/revoke on a missing event → 404", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/breakglass/${MISSING}/revoke`,
        headers: COMPLIANCE,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      await app.close();
    });

    it("GET /engagements/:id/summary on a missing engagement → 404", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/engagements/${MISSING}/summary`,
        headers: COMPLIANCE,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      await app.close();
    });

    it("PATCH /engagements/:id on a missing engagement → 404", async () => {
      const app = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/engagements/${MISSING}`,
        headers: COMPLIANCE,
        payload: { cancel: true },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      await app.close();
    });
  });
});

// ── Tracked proof obligations gated on infrastructure / frontend this run defers ──
describe("M3-T11 — deferred proof obligations (infra/frontend-gated)", () => {
  // §9.3 cross-tenant object IDOR on a real Postgres (tenant-B actor, tenant-A id → 404):
  // enforced by RLS, proven behaviourally in authz-rls-isolation.test.ts; the live form is
  // owned by the shared live harness (WARDENX_TEST_DATABASE_URL).
  it.todo("§9.3 live: tenant-B actor using a tenant-A break_glass_event/engagement id → 404");
  // §9.4 Playwright E2E — M3 admin/console screens (M3-T09) are DEFERRED out of the manifest
  // scope (no apps/web codePath for M3; follows the M2-T09 / ADR-0030 precedent).
  it.todo("§9.4 E2E: RN caseload list; non-caseload 404; break-glass reason flow + banner");
  it.todo("§9.4 E2E: auditor magic-link → read-only chart → blocked export → window expiry");
  // §9.5 performance — authz.abac_eval p95 < 3ms / cache-resolution p95 < 1ms — needs the
  // metrics harness; tracked here so the obligation stays visible.
  it.todo("§9.5 perf: abac_eval p95 < 3ms warm; cached permission resolution p95 < 1ms");
});
