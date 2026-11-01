// CW-RUST-M02 P1 — the Bun→Rust bridge at the real route, through the real buildServer hook chain (no live infra).
//
// Proves: with no bridge the route is unchanged; the bridge receives the actor from the verified context stamps
// (sessionId / sessionClass), never from a header; the shadow callback fires only after the response is sent; a
// client-sent X-CW-Actor-Assertion never reaches the authenticate hook, a route, or the bridge.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
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

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const KEYS = ["patient.read", "visit.read"];

type BridgeInput = Parameters<NonNullable<AuthzRouteDeps["mePermissionsBridge"]>["handle"]>[0];

function makeServer(bridge?: AuthzRouteDeps["mePermissionsBridge"]) {
  const seenByAuthenticate: unknown[] = [];
  const authenticate = (request: FastifyRequest): void => {
    seenByAuthenticate.push(request.headers["x-cw-actor-assertion"]);
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user === "") return;
    request.context.userId = user;
    request.context.organizationId = ORG;
    // The real authenticate hook stamps these (bootstrap/plugins/authenticate.ts).
    request.context.attributes.sessionId = "sess-123";
    request.context.attributes.sessionClass = "staff";
  };
  const grants = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: USER,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
    },
  ]);
  registerEffectivePermissionResolver(grants.store);
  const app = buildServer({ authenticate, security: { rateLimitEnabled: false } });
  const deps: AuthzRouteDeps = {
    roles: createInMemoryRoleStore().store,
    membershipRoles: createInMemoryMembershipRoleStore().store,
    breakGlass: createInMemoryBreakGlassStore().store,
    engagements: createInMemoryEngagementStore().store,
    auditorSessions: createInMemoryAuditorSessionMinter().minter,
    notifier: createInMemoryComplianceNotifier().notifier,
    effectivePermissions: createFixedPermissionResolver([
      { organizationId: ORG, userId: USER, permissions: KEYS },
    ]).resolver,
    audit: createInMemoryAuditExecutor().executor,
    cosignPolicy: async () => false,
    ...(bridge
      ? { mePermissionsBridge: bridge, freshPermissions: async () => new Set(["fresh.only"]) }
      : {}),
  };
  registerAuthorizationRoutes(app, deps);
  return { app, seenByAuthenticate };
}

const AS_USER = { "x-test-user": USER };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("CW-RUST-M02 bridge at GET /api/v1/me/permissions", () => {
  it("without a bridge, the response is exactly the pre-P1 one", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/permissions",
      headers: AS_USER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ permissions: KEYS });
    await app.close();
  });

  it("an unauthenticated request never reaches the bridge (401 from Bun, as before)", async () => {
    let calls = 0;
    const { app } = makeServer({
      handle: async (i) => {
        calls++;
        return i.bun();
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/me/permissions" });
    expect(res.statusCode).toBe(401);
    expect(calls).toBe(0);
    await app.close();
  });

  it("passes the actor from the verified context stamps, plus Bun's handler and an uncached resolver", async () => {
    let seen: BridgeInput | undefined;
    const { app } = makeServer({
      handle: async (i) => {
        seen = i;
        return i.bun();
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/permissions",
      headers: AS_USER,
    });
    expect(res.json()).toEqual({ permissions: KEYS });
    expect(seen?.actor).toMatchObject({
      userId: USER,
      organizationId: ORG,
      sessionId: "sess-123",
      sessionClass: "staff",
    });
    expect(seen?.actor.requestId).toMatch(/\S/);
    expect(await seen?.bun()).toEqual({ permissions: KEYS });
    expect(await seen?.fresh()).toEqual({ permissions: ["fresh.only"] });
    await app.close();
  });

  it("serves whatever validated body the bridge returns (serve mode stand-in)", async () => {
    const { app } = makeServer({ handle: async () => ({ permissions: ["from.rust"] }) });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/permissions",
      headers: AS_USER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ permissions: ["from.rust"] });
    await app.close();
  });

  it("runs the shadow callback only after the response has been sent", async () => {
    const order: string[] = [];
    const { app } = makeServer({
      handle: async (i) => {
        i.afterResponse(() => order.push("after-response"));
        order.push("handler-returned");
        return i.bun();
      },
    });
    app.addHook("onResponse", async () => {
      order.push("on-response");
    });
    await app.inject({ method: "GET", url: "/api/v1/me/permissions", headers: AS_USER });
    await new Promise((r) => setTimeout(r, 10));
    expect(order[0]).toBe("handler-returned");
    expect(order).toContain("after-response");
    await app.close();
  });

  it("a client-sent X-CW-Actor-Assertion is gone before the authenticate hook and the route", async () => {
    let routeSaw: boolean | undefined;
    const { app, seenByAuthenticate } = makeServer({
      handle: async (i) => i.bun(),
    });
    app.get("/__probe", async (req) => {
      routeSaw = "x-cw-actor-assertion" in req.headers;
      return {};
    });
    for (const name of ["X-CW-Actor-Assertion", "x-cw-actor-assertion"]) {
      await app.inject({
        method: "GET",
        url: "/__probe",
        headers: { [name]: "forged.jws.sig", ...AS_USER },
      });
      expect(routeSaw).toBe(false);
    }
    await app.inject({
      method: "GET",
      url: "/api/v1/me/permissions",
      headers: { "x-cw-actor-assertion": "forged.jws.sig", ...AS_USER },
    });
    expect(seenByAuthenticate.every((v) => v === undefined)).toBe(true);
    expect(seenByAuthenticate.length).toBeGreaterThanOrEqual(3);
    await app.close();
  });
});
