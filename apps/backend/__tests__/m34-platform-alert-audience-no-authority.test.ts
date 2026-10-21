// An operator bound into a tenant with the self-only-permission `platform_alert_audience` role (bind-platform-staff.ts,
// migration 1097) must hold NO authority over the tenant's users. The review finding: binding `platform_ops` there
// let the operator call POST /api/v1/orgs/:orgId/users/:userId/password-reset (gated on requirePermission alone).
// The live suite proves the DB side (the role holds only `alert.inbox.self`); this proves the routes refuse with 403.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createInMemoryMessagingService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createContextActorResolver,
  createInMemoryAuditExecutor,
  registerCredentialRoutes,
} from "../src/modules/02-identity/index";
import { registerMessagingRoutes } from "../src/modules/36-messaging/index";

const ORG = "org_a";
const URL_FOR = (userId: string) => `/api/v1/orgs/${ORG}/users/${userId}/password-reset`;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const role = request.headers["x-test-role"];
  request.context.roles = typeof role === "string" ? [role] : [];
  request.context.attributes.stepUpRecent = true;
}

function makeServer() {
  const resetPassword = vi.fn(async () => ({ reset: true }));
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "operator",
        // The migration-1097 role: bound, enabled, and carrying only alert.inbox.self.
        grants: [
          {
            roleKey: "platform_alert_audience",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["alert.inbox.self"],
          },
        ],
      },
      {
        orgId: ORG,
        userId: "admin",
        grants: [
          {
            roleKey: "org_admin",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["user.password.reset"],
          },
        ],
      },
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerCredentialRoutes(app, {
    actors: createContextActorResolver(),
    audit: createInMemoryAuditExecutor().executor,
    service: { resetPassword } as never,
    lifecycle: {} as never,
  });
  return { app, resetPassword };
}

describe("tenant password-reset vs. a bound platform_alert_audience operator", () => {
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("returns 403 and never reaches the service for the audience-role operator", async () => {
    const { app, resetPassword } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("victim"),
      headers: { "x-test-user": "operator", "x-test-role": "platform_alert_audience" },
      payload: { generateTemporaryPassword: true },
    });
    expect(res.statusCode).toBe(403);
    expect(resetPassword).not.toHaveBeenCalled();
    await app.close();
  });

  it("control: a tenant org_admin holding user.password.reset is not refused", async () => {
    const { app, resetPassword } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL_FOR("victim"),
      headers: { "x-test-user": "admin", "x-test-role": "org_admin" },
      payload: { generateTemporaryPassword: true },
    });
    expect(res.statusCode).not.toBe(403);
    expect(resetPassword).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ── sweep: the operator's ONLY key is `alert.inbox.self` (migration 1097) ───────────────────────────────────────
// Real M36 routes + the real Authorization Contract. `user.deactivate` / `role.assign` / `patient.read` are probed
// through requirePermission with the exact key their routes gate on (their registrars need heavy services).
const OPERATOR_HEADERS = { "x-test-user": "operator", "x-test-role": "platform_alert_audience" };

function makeMessagingServer() {
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      eligibleStaff: [],
      careTeamPatients: [],
      channels: [],
      alerts: ["operator", "someone_else"].map((userId) => ({
        orgId: ORG,
        userId,
        item: {
          alertId: `al_${userId}`,
          eventType: "m34.tenant_export.oversized_hold",
          category: "administrative" as const,
          severity: "warn" as const,
          summary: "held",
          deepLink: null,
          createdAt: "2026-06-14T00:00:00Z",
          deliveryStatus: "delivered" as const,
          readAt: null,
        },
      })),
    },
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "operator",
        grants: [
          {
            roleKey: "platform_alert_audience",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["alert.inbox.self"],
          },
        ],
      },
    ]).store,
  );
  registerAbacRegistry(createPredicateRegistry());
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMessagingRoutes(app, { service, announcements: service });
  for (const [path, key] of [
    ["/probe/user-deactivate", "user.deactivate"],
    ["/probe/role-assign", "role.assign"],
    ["/probe/patient-read", "patient.read"],
  ] as const) {
    app.get(path, { preHandler: [requirePermission(key)] }, async () => ({ ok: true }));
  }
  return app;
}

describe("a zero-authority platform_alert_audience session (alert.inbox.self only)", () => {
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("is refused 403 on user, role, patient and messaging routes", async () => {
    const app = makeMessagingServer();
    const refused = [
      { method: "GET", url: "/probe/user-deactivate" },
      { method: "GET", url: "/probe/role-assign" },
      { method: "GET", url: "/probe/patient-read" },
      { method: "GET", url: "/api/v1/messaging/channels" },
      { method: "POST", url: "/api/v1/messaging/dm", payload: { userId: "someone_else" } },
      { method: "GET", url: "/api/v1/alert-rules" },
    ] as const;
    for (const r of refused) {
      const res = await app.inject({ ...r, headers: OPERATOR_HEADERS });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
    await app.close();
  });

  it("lists and marks read its OWN alert, and gets 404 on another user's", async () => {
    const app = makeMessagingServer();
    const inbox = await app.inject({
      method: "GET",
      url: "/api/v1/alerts/inbox",
      headers: OPERATOR_HEADERS,
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().alerts.map((a: { alertId: string }) => a.alertId)).toEqual(["al_operator"]);
    const own = await app.inject({
      method: "POST",
      url: "/api/v1/alerts/al_operator/read",
      headers: OPERATOR_HEADERS,
    });
    expect(own.statusCode).toBe(204);
    const other = await app.inject({
      method: "POST",
      url: "/api/v1/alerts/al_someone_else/read",
      headers: OPERATOR_HEADERS,
    });
    expect(other.statusCode).toBe(404);
    await app.close();
  });
});
