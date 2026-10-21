// WP 4.8 (ADR-0075) - the deep-link resolver: the route over the REAL Authorization Contract, and the service's
// "every failure is the same NotFoundError" rule with fakes (the SQL half is the live suite).
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DeliveryTargetIds } from "../src/modules/36-messaging/delivery-target/delivery-target-reader-db";
import { createDeliveryTargetService } from "../src/modules/36-messaging/delivery-target/delivery-target-service";
import { registerDeliveryTargetRoutes } from "../src/modules/36-messaging/routes/delivery-target-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const MSG = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const REQ = "cccccccc-cccc-4ccc-8ccc-000000000001";
const DELIVERY = "dddddddd-dddd-4ddd-8ddd-000000000001";
const TARGET = { channelId: CH, messageId: MSG };

let readCalls: unknown[][] = [];
let viewCalls: unknown[][] = [];
let reading: DeliveryTargetIds | null = TARGET;
let visible = true;

const service = createDeliveryTargetService({
  read: async (...args) => {
    readCalls.push(args);
    return reading;
  },
  openRequestId: async () => REQ,
  messaging: {
    canViewChannel: async (...args) => {
      viewCalls.push(args);
      return visible;
    },
  },
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "nurse",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["messaging.read"] },
        ],
      },
    ]).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerDeliveryTargetRoutes(
    app,
    { service },
    { read: requirePermission("messaging.read") as Handler },
  );
  return app;
}

const resolve = (app: ReturnType<typeof makeServer>, user: string | null, id: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/messaging/deliveries/${id}/target`,
    headers: user ? { "x-test-user": user } : {},
  });

beforeEach(() => {
  readCalls = [];
  viewCalls = [];
  reading = TARGET;
  visible = true;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /deliveries/:id/target", () => {
  it("returns exactly three ids for the caller's own delivery", async () => {
    const app = makeServer();
    const res = await resolve(app, "nurse", DELIVERY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ channel_id: CH, message_id: MSG, ack_request_id: REQ });
    expect(readCalls[0]).toEqual([ORG, "nurse", DELIVERY]);
    expect(viewCalls[0]).toEqual([ORG, "nurse", CH]);
    await app.close();
  });

  it("answers the identical 404 body for a miss, a hidden channel and a malformed id (and never echoes the id)", async () => {
    const app = makeServer();
    reading = null;
    const missing = await resolve(app, "nurse", DELIVERY);
    reading = TARGET;
    visible = false;
    const hidden = await resolve(app, "nurse", DELIVERY);
    reading = null;
    const malformed = await resolve(app, "nurse", "not-a-uuid");
    for (const res of [missing, hidden, malformed]) expect(res.statusCode).toBe(404);
    const shape = (r: { json(): Record<string, unknown> }) => {
      const body = JSON.stringify(r.json());
      return body.replace(/"(correlation|request)[A-Za-z_]*":"[^"]*"/gi, "");
    };
    expect(shape(hidden)).toBe(shape(missing));
    expect(shape(malformed)).toBe(shape(missing));
    expect(missing.body).not.toContain(DELIVERY);
    expect(malformed.body).not.toContain("not-a-uuid");
    await app.close();
  });

  it("requires messaging.read and a session", async () => {
    const app = makeServer();
    expect((await resolve(app, null, DELIVERY)).statusCode).toBe(401);
    expect((await resolve(app, "nobody", DELIVERY)).statusCode).toBe(403);
    expect(readCalls).toEqual([]);
    await app.close();
  });
});

describe("delivery target service", () => {
  const actor = { orgId: ORG, userId: "nurse" };

  it("does the same channel check on a miss as on a hit, then refuses with one NotFoundError", async () => {
    reading = null;
    await expect(service.resolve(actor, DELIVERY)).rejects.toBeInstanceOf(NotFoundError);
    expect(viewCalls).toHaveLength(1);
  });

  it("refuses when the user can no longer see the channel", async () => {
    visible = false;
    await expect(service.resolve(actor, DELIVERY)).rejects.toMatchObject({
      message: "notification not found",
    });
  });
});
