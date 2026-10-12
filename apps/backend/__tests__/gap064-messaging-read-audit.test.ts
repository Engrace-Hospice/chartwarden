// GAP-064 — M36 message history / channel detail / alert inbox reads are PHI reads: they sit under the
// §2.5 read-audit coverage gate and emit a read event attributed to the care_team channel's patient.
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
import { createInMemoryMessagingService } from "@wardenx/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READ_AUDIT_PREFIXES, buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";

const ORG = "org_a";
const CT = "ch_ct";

interface CapturedRow {
  eventType: string;
  resourceKind: string;
  resourceId?: string;
  patientId?: string;
  context?: Record<string, unknown>;
}
let captured: CapturedRow[] = [];
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({
    values: async (row: CapturedRow) => {
      captured.push(row);
    },
  }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["clinical_rn"];
  request.context.locationIds = [];
}

function makeServer() {
  const service = createInMemoryMessagingService({
    now: () => new Date("2026-06-15T12:00:00Z"),
    seed: {
      eligibleStaff: [
        { orgId: ORG, userId: "rn_1", displayName: "RN One", roles: ["clinical_rn"] },
      ],
      channels: [
        {
          channelId: CT,
          orgId: ORG,
          kind: "care_team",
          title: "Care Team",
          subjectId: "patient_x",
          members: [{ userId: "rn_1", role: "owner" }],
        },
      ],
    },
  });
  const grants = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "rn_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.read", "messaging.send"],
        },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grants.store);
  const registry = createPredicateRegistry();
  registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) =>
    typeof target.id === "string" && ctx.organizationId && ctx.userId
      ? service.canViewChannel(ctx.organizationId, ctx.userId, target.id)
      : false,
  );
  registerAbacRegistry(registry);
  const app = buildServer({
    db: fakeDb,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerMessagingRoutes(app, { service });
  return { app, service };
}
const RN1 = { "x-test-user": "rn_1" };

beforeEach(() => {
  captured = [];
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GAP-064 messaging read-audit", () => {
  it("governs the messaging, alerts and notifications read surfaces", () => {
    for (const p of ["/api/v1/messaging", "/api/v1/alerts", "/api/v1/notifications"])
      expect(DEFAULT_READ_AUDIT_PREFIXES).toContain(p);
  });

  it("channel detail emits a view event attributed to the care_team patient", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${CT}`,
      headers: RN1,
    });
    expect(res.statusCode).toBe(200);
    const row = captured.find((r) => r.eventType === "messaging_channel.viewed");
    expect(row?.resourceId).toBe(CT);
    expect(JSON.stringify(row)).toContain("patient_x");
    await app.close();
  });

  it("message history emits a list-read event attributed to the patient", async () => {
    const { app, service } = makeServer();
    await service.sendMessage(ORG, { channelId: CT, authorUserId: "rn_1", body: "hello" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${CT}/messages`,
      headers: RN1,
    });
    expect(res.statusCode).toBe(200);
    const row = captured.find((r) => r.eventType === "message.list_viewed");
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).toContain("patient_x");
    await app.close();
  });

  it("a thread read (WP 2.2) emits a view event naming the root message, attributed to the patient", async () => {
    const { app, service } = makeServer();
    const root = await service.sendMessage(ORG, {
      channelId: CT,
      authorUserId: "rn_1",
      body: "root",
    });
    await service.sendMessage(ORG, {
      channelId: CT,
      authorUserId: "rn_1",
      body: "reply",
      parentMessageId: root.messageId,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${CT}/messages/${root.messageId}/thread`,
      headers: RN1,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().root.replyCount).toBe(1);
    const row = captured.find((r) => r.eventType === "message.viewed");
    expect(row?.resourceId).toBe(root.messageId);
    expect(JSON.stringify(row)).toContain("patient_x");
    await app.close();
  });

  it("the alert inbox emits a list-read event", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/alerts/inbox", headers: RN1 });
    expect(res.statusCode).toBe(200);
    expect(captured.some((r) => r.eventType === "alert.list_viewed")).toBe(true);
    await app.close();
  });

  it("a denied read (non-2xx) emits nothing", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/messaging/channels/${CT}` });
    expect(res.statusCode).toBe(401);
    expect(captured).toEqual([]);
    await app.close();
  });
});
