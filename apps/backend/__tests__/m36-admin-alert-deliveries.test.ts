// GAP-165 — `GET /api/v1/admin/messaging/alert-deliveries`: platform-ops-only, metadata-only, audited per read.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type AlertDeliveriesFilter,
  type AlertDeliveryRow,
  messagingAdminPlatformOps,
  registerAdminAlertDeliveriesRoutes,
} from "../src/modules/36-messaging/routes/admin-alert-deliveries-routes";

const ORG = "org_a";
const URL = "/api/v1/admin/messaging/alert-deliveries";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const OPS = { "x-test-user": "ops_1", "x-test-org": ORG, "x-test-roles": "platform_ops" };
// A tenant admin that somehow acquired the platform key (a key travels with a role template).
const TENANT_ADMIN = { "x-test-user": "tenant_1", "x-test-org": ORG, "x-test-roles": "org_admin" };

const ROW: AlertDeliveryRow = {
  deliveryId: "d1",
  organizationId: "org_b",
  alertId: "a1",
  alertCategory: "clinical_urgent",
  alertSeverity: "critical",
  channel: "sms",
  status: "failed",
  failReason: "carrier rejected",
  queuedAt: "2026-10-06T10:00:00.000Z",
  sentAt: null,
  settledAt: "2026-10-06T10:01:00.000Z",
};

function makeServer(opts: { auditFails?: boolean; rows?: readonly AlertDeliveryRow[] } = {}) {
  const listed: AlertDeliveriesFilter[] = [];
  const audited: Array<{ actorUserId: string; rowCount: number }> = [];
  const grants = createInMemoryEffectivePermissionStore(
    ["ops_1", "tenant_1"].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.admin.read"],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(grants.store);
  const registry = registerAbacRegistry(createPredicateRegistry());
  registry.register("messaging_admin_platform_ops", messagingAdminPlatformOps);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdminAlertDeliveriesRoutes(app, {
    async list(filter) {
      listed.push(filter);
      return opts.rows ?? [ROW];
    },
    async audit(entry) {
      if (opts.auditFails) throw new Error("audit sink down");
      audited.push({ actorUserId: entry.actorUserId, rowCount: entry.rowCount });
    },
  });
  return { app, listed, audited };
}

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

describe("GAP-165 — GET /admin/messaging/alert-deliveries", () => {
  it("refuses a tenant role that holds the key but not platform_ops (403), reading and auditing nothing", async () => {
    const { app, listed, audited } = makeServer();
    const res = await app.inject({ method: "GET", url: URL, headers: TENANT_ADMIN });
    expect(res.statusCode).toBe(403);
    expect(listed).toEqual([]);
    expect(audited).toEqual([]);
    await app.close();
  });

  it("refuses an unauthenticated caller", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: URL });
    expect([401, 403]).toContain(res.statusCode);
    await app.close();
  });

  it("returns delivery metadata to platform_ops (default filter: failed) and audits the read", async () => {
    const { app, listed, audited } = makeServer();
    const res = await app.inject({ method: "GET", url: URL, headers: OPS });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([ROW]);
    expect(listed).toEqual([{ status: "failed", limit: 50, before: null }]);
    expect(audited).toEqual([{ actorUserId: "ops_1", rowCount: 1 }]);
    // Metadata only: nothing that identifies a recipient or a destination.
    expect(Object.keys(res.json().items[0])).not.toEqual(
      expect.arrayContaining(["recipientUserId"]),
    );
    await app.close();
  });

  it("passes filters through and pages by the last row's queuedAt when the page is full", async () => {
    const { app, listed } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `${URL}?status=pending&limit=1&before=2026-10-07T00:00:00.000Z`,
      headers: OPS,
    });
    expect(res.statusCode).toBe(200);
    expect(listed[0]).toEqual({ status: "pending", limit: 1, before: "2026-10-07T00:00:00.000Z" });
    expect(res.json().nextBefore).toBe(ROW.queuedAt);
    await app.close();
  });

  it("rejects an invalid filter (422) before touching the reader", async () => {
    const { app, listed } = makeServer();
    const res = await app.inject({ method: "GET", url: `${URL}?limit=9999`, headers: OPS });
    expect(res.statusCode).toBe(422);
    expect(listed).toEqual([]);
    await app.close();
  });

  it("does not release rows when the audit write fails (an unaudited cross-tenant read must not succeed)", async () => {
    const { app } = makeServer({ auditFails: true });
    const res = await app.inject({ method: "GET", url: URL, headers: OPS });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain("carrier rejected");
    await app.close();
  });
});
