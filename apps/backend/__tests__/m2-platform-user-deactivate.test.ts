// apps/backend/__tests__/m2-platform-user-deactivate.test.ts — POST /api/v1/platform/users/:id/deactivate
// (M2 §4.7 `user.deactivate` — "platform_ops (any)"), through the FULL M1 middleware chain via Fastify
// `inject` with in-memory adapters.
//
// The tenant route (`POST /api/v1/users/:id/deactivate`) is org-bounded since GAP-001, so the spec's
// cross-org platform grant needs its own route. These cases pin who may call it: the decision is the
// platform-owned ROLE, not the `user.deactivate` permission an org_admin also holds.
//
// The header shim derives `context.roles` from role ROWS through the production `roleConfersKey` rule —
// the same filter the enrichment reader (packages/auth/src/rbac/drizzle-store.ts) applies — so a
// tenant-owned `platform_ops` row (the GAP-003 spoof) is modeled the way production sees it: it confers
// nothing, and the route must refuse even though the caller holds `user.deactivate` in their own org.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
  roleConfersKey,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type IdentityOutboxPort,
  type MembershipRecord,
  createContextActorResolver,
  createInMemoryAuditExecutor,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
  registerPlatformUserRoutes,
  userLifecyclePlatformOpsPredicate,
} from "../src/modules/02-identity/index";

const URL_FOR = (userId: string) => `/api/v1/platform/users/${userId}/deactivate`;

/**
 * Test-only auth shim. `x-test-role-rows` is a comma list of `key@owner`, where owner is `platform`
 * (an `organization_id IS NULL` row) or an org id (a tenant-owned row). `x-test-stepup: 1` marks a fresh
 * step-up (read by the test stand-in for M3's `step_up_recent`).
 */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const rows = request.headers["x-test-role-rows"];
  const roleRows =
    typeof rows === "string" && rows.length > 0
      ? rows.split(",").map((r) => {
          const [key = "", owner = ""] = r.split("@");
          return {
            key,
            organizationId: owner === "platform" ? null : owner,
            category: key.startsWith("platform_") ? "platform_staff" : "admin",
          };
        })
      : [];
  request.context.roles = roleRows.filter(roleConfersKey).map((r) => r.key);
  if (request.headers["x-test-stepup"] === "1") request.context.attributes.stepUpRecent = true;
}

function membership(over: Partial<MembershipRecord> & { membershipId: string }): MembershipRecord {
  return {
    userId: "rn_user",
    organizationId: "org_a",
    organizationName: "Alpha",
    status: "active",
    isAdmin: false,
    defaultLocationIds: [],
    ...over,
  };
}

/** The target: a clinician with live memberships in TWO orgs (the case the tenant route refuses). */
const SEED: MembershipRecord[] = [
  membership({ membershipId: "rn_a", organizationId: "org_a" }),
  membership({ membershipId: "rn_b", organizationId: "org_b", organizationName: "Beta" }),
  membership({ membershipId: "ops_m", userId: "ops_1", organizationId: "org_ops" }),
  membership({ membershipId: "adm_m", userId: "admin_1", organizationId: "org_a", isAdmin: true }),
];

/** Everyone below holds `user.deactivate` in their bound org — RBAC passes, the role decides. */
const DEACTIVATE_GRANT = (orgId: string, userId: string, roleKey: string) => ({
  orgId,
  userId,
  grants: [{ roleKey, enabled: true, expiresAt: null, permissionKeys: ["user.deactivate"] }],
});

const PLATFORM_OPS = {
  "x-test-user": "ops_1",
  "x-test-org": "org_ops",
  "x-test-role-rows": "platform_ops@platform",
  "x-test-stepup": "1",
};
const TENANT_ADMIN = {
  "x-test-user": "admin_1",
  "x-test-org": "org_a",
  "x-test-role-rows": "org_admin@org_a",
  "x-test-stepup": "1",
};
/** GAP-003 spoof: a TENANT-owned role row keyed `platform_ops`. */
const TENANT_SPOOF = { ...TENANT_ADMIN, "x-test-role-rows": "org_admin@org_a,platform_ops@org_a" };

function makeServer(seed: MembershipRecord[] = SEED) {
  const memberships = createInMemoryMembershipRepository(seed);
  const sessions = createInMemorySessionWriter();
  const users = createInMemoryUserDirectory(memberships.repo);
  const auditSink = createInMemoryAuditExecutor();
  const published: Parameters<IdentityOutboxPort["publish"]>[0][] = [];

  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      DEACTIVATE_GRANT("org_ops", "ops_1", "platform_ops"),
      DEACTIVATE_GRANT("org_a", "admin_1", "org_admin"),
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register("user_lifecycle_platform_ops", userLifecyclePlatformOpsPredicate);
  // Test stand-in for M3's `step_up_recent` (the ipu-inject precedent).
  registry.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPlatformUserRoutes(app, {
    actors: createContextActorResolver(),
    users: users.directory,
    sessions: sessions.writer,
    audit: auditSink.executor,
    outbox: {
      async publish(input) {
        published.push(input);
      },
    },
  });
  return { app, users, sessions, auditSink, published, memberships };
}

describe("POST /api/v1/platform/users/:id/deactivate (M2 §4.7 platform_ops any)", () => {
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("a platform-owned platform_ops deactivates a user who is a member of two orgs → 200, both memberships revoked", async () => {
    const { app, users, sessions, auditSink, published, memberships } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("rn_user"),
      headers: PLATFORM_OPS,
      payload: { reason: "credential compromise — platform offboard" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      deactivated: true,
      alreadyDeactivated: false,
      sessionsRevoked: 1,
      membershipsRevoked: 2,
    });
    expect(users.isDeactivated("rn_user")).toBe(true);
    // §2.2.1: "All memberships revoked" — in every org, not just the operator's.
    const after = await memberships.repo.listForUser("rn_user");
    expect(after.map((m) => [m.membershipId, m.status])).toEqual([
      ["rn_a", "revoked"],
      ["rn_b", "revoked"],
    ]);
    expect(sessions.revokedUsers()).toEqual(["rn_user"]);

    const row = auditSink.rows.find((r) => r.eventType === "m2.user.deactivated");
    expect(row?.resourceId).toBe("rn_user");
    expect(row?.retentionClass).toBe("compliance");
    expect(row?.context).toMatchObject({
      reason: "credential compromise — platform offboard",
      scope: "platform",
      memberOrganizationIds: ["org_a", "org_b"],
      revokedMembershipIds: ["rn_a", "rn_b"],
    });
    expect(published).toEqual([
      {
        eventName: "m2.user.deactivated",
        payload: {
          userId: "rn_user",
          reason: "credential compromise — platform offboard",
          scope: "platform",
        },
        organizationId: "org_ops",
        aggregateKind: "user",
        aggregateId: "rn_user",
      },
    ]);
    await app.close();
  });

  it("a tenant org_admin (holds user.deactivate, no platform role) → 403, nothing touched", async () => {
    const { app, users, sessions, auditSink } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("rn_user"),
      headers: TENANT_ADMIN,
      payload: { reason: "trying the platform route" },
    });
    expect(res.statusCode).toBe(403);
    expect(users.isDeactivated("rn_user")).toBe(false);
    expect(sessions.revokedUsers()).toEqual([]);
    expect(auditSink.rows).toEqual([]);
    await app.close();
  });

  it("GAP-003: a TENANT-owned role keyed platform_ops confers nothing → 403", async () => {
    const { app, users, sessions } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("rn_user"),
      headers: TENANT_SPOOF,
      payload: { reason: "self-minted platform_ops" },
    });
    expect(res.statusCode).toBe(403);
    expect(users.isDeactivated("rn_user")).toBe(false);
    expect(sessions.revokedUsers()).toEqual([]);
    await app.close();
  });

  it("a platform-owned role outside the user-lifecycle set (platform_sales) → 403", async () => {
    const { app, users } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("rn_user"),
      headers: { ...PLATFORM_OPS, "x-test-role-rows": "platform_sales@platform" },
      payload: { reason: "not a lifecycle role" },
    });
    expect(res.statusCode).toBe(403);
    expect(users.isDeactivated("rn_user")).toBe(false);
    await app.close();
  });

  it("platform_ops without a fresh step-up → 403 STEP_UP_REQUIRED, nothing touched", async () => {
    const { app, users } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("rn_user"),
      headers: { ...PLATFORM_OPS, "x-test-stepup": "0" },
      payload: { reason: "no step-up" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(users.isDeactivated("rn_user")).toBe(false);
    await app.close();
  });

  it("a missing or blank reason → 422 VALIDATION_FAILED, nothing touched", async () => {
    const { app, users } = makeServer();
    for (const payload of [{}, { reason: "   " }]) {
      const res = await app.inject({
        method: "POST",
        url: URL_FOR("rn_user"),
        headers: PLATFORM_OPS,
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION_FAILED");
    }
    expect(users.isDeactivated("rn_user")).toBe(false);
    await app.close();
  });

  it("an unknown user → 404, no audit, no event", async () => {
    const { app, sessions, auditSink, published } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("nobody"),
      headers: PLATFORM_OPS,
      payload: { reason: "no such person" },
    });
    expect(res.statusCode).toBe(404);
    expect(sessions.revokedUsers()).toEqual([]);
    expect(auditSink.rows).toEqual([]);
    expect(published).toEqual([]);
    await app.close();
  });

  it("is idempotent: a second call → 200 alreadyDeactivated, sessions reaped again, no second audit/event", async () => {
    const { app, sessions, auditSink, published } = makeServer();
    const call = () =>
      app.inject({
        method: "POST",
        url: URL_FOR("rn_user"),
        headers: PLATFORM_OPS,
        payload: { reason: "offboard" },
      });
    expect((await call()).statusCode).toBe(200);
    const second = await call();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      deactivated: true,
      alreadyDeactivated: true,
      sessionsRevoked: 1,
      membershipsRevoked: 0,
    });
    expect(sessions.revokedUsers()).toEqual(["rn_user", "rn_user"]);
    expect(auditSink.rows.filter((r) => r.eventType === "m2.user.deactivated")).toHaveLength(1);
    expect(published).toHaveLength(1);
    await app.close();
  });

  it("a repeat call sweeps a live membership an already-deactivated user still holds", async () => {
    const { app, users, memberships } = makeServer();
    const call = () =>
      app.inject({
        method: "POST",
        url: URL_FOR("rn_user"),
        headers: PLATFORM_OPS,
        payload: { reason: "offboard" },
      });
    expect((await call()).statusCode).toBe(200);
    // A membership that came back live after the first call (e.g. a pre-§2.4 deactivation's leftover).
    await memberships.repo.setStatus("rn_b", "active");
    const second = await call();
    expect(second.json()).toMatchObject({ alreadyDeactivated: true, membershipsRevoked: 1 });
    expect(users.isDeactivated("rn_user")).toBe(true);
    const after = await memberships.repo.listForUser("rn_user");
    expect(after.every((m) => m.status === "revoked")).toBe(true);
    await app.close();
  });
});
