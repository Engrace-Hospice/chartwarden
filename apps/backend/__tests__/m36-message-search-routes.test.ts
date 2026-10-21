// WP 2.7a - GET /channels/:id/search over the in-memory service: gates, validation, no-leak, and a read-audit row that
// records the channel and the filter SHAPE but never the search text.
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
import { createInMemoryMessagingService } from "@chartwarden/messaging";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  CHANNEL_VISIBILITY_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/index";

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-00000000c4c4";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-00000000c4c4";
const TERM = "zebrafish";

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
    seed: {
      eligibleStaff: ["rn_1", "rn_2"].map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["clinical_rn"],
      })),
      channels: [
        {
          channelId: CH,
          orgId: ORG,
          kind: "care_team" as const,
          subjectId: "patient_x",
          members: [{ userId: "rn_1" }],
        },
        {
          channelId: OTHER,
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc_2",
          members: [{ userId: "rn_2" }],
        },
      ],
    },
  });
  const grants = createInMemoryEffectivePermissionStore(
    ["rn_1", "rn_2"].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["messaging.read", "messaging.send"],
        },
      ],
    })),
  );
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
  registerMessagingRoutes(app, { service, announcements: service });
  return { app, service };
}
const as = (user: string) => ({ "x-test-user": user });
const url = (query: string, channel = CH) =>
  `/api/v1/messaging/channels/${channel}/search?${query}`;

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

describe("GET /channels/:id/search", () => {
  it("returns matching live messages and nothing from another channel", async () => {
    const { app, service } = makeServer();
    await service.sendMessage(ORG, { channelId: CH, authorUserId: "rn_1", body: `a ${TERM} b` });
    await service.sendMessage(ORG, { channelId: OTHER, authorUserId: "rn_2", body: TERM });
    const res = await app.inject({ method: "GET", url: url(`q=${TERM}`), headers: as("rn_1") });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
    expect(res.json().scanCapped).toBe(false);
    await app.close();
  });

  it("is 401 anonymous and refused for a non-member, whatever the channel id", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: url("q=hello") })).statusCode).toBe(401);
    const member = await app.inject({ method: "GET", url: url("q=hello"), headers: as("rn_2") });
    const unknown = await app.inject({
      method: "GET",
      url: url("q=hello", "cccccccc-cccc-4ccc-8ccc-00000000c4c4"),
      headers: as("rn_2"),
    });
    expect(member.statusCode).toBe(unknown.statusCode);
    expect(member.statusCode).toBeGreaterThanOrEqual(403);
    await app.close();
  });

  it("422s a one-character query, an empty search and a malformed channel id", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: url("q=a"), headers: as("rn_1") })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: url(""), headers: as("rn_1") })).statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: url("q=hello", "nope"), headers: as("rn_1") }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("audits the read against the patient with the filter shape and WITHOUT the query text", async () => {
    const { app, service } = makeServer();
    await service.sendMessage(ORG, { channelId: CH, authorUserId: "rn_1", body: TERM });
    await app.inject({ method: "GET", url: url(`q=${TERM}&limit=5`), headers: as("rn_1") });
    const row = captured.find((r) => r.eventType === "message.list_viewed");
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).toContain("patient_x");
    expect(row?.context?.filter).toEqual({ q: "[omitted]", limit: 5 });
    expect(row?.resourceId).toBe(CH); // the channel is the event's resource id
    expect(JSON.stringify(captured)).not.toContain(TERM);
    await app.close();
  });
});
