// An operator bound into a tenant with the zero-permission `platform_alert_audience` role (bind-platform-staff.ts,
// migration 1097) must hold NO authority over the tenant's users. The review finding: binding `platform_ops` there
// let the operator call POST /api/v1/orgs/:orgId/users/:userId/password-reset (gated on requirePermission alone).
// The live suite proves the DB side (no role_permission rows); this proves the route refuses with 403.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createContextActorResolver,
  createInMemoryAuditExecutor,
  registerCredentialRoutes,
} from "../src/modules/02-identity/index";

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
        // The migration-1097 role: bound, enabled, and carrying no permission keys at all.
        grants: [
          {
            roleKey: "platform_alert_audience",
            enabled: true,
            expiresAt: null,
            permissionKeys: [],
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

  it("returns 403 and never reaches the service for the zero-permission operator", async () => {
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
