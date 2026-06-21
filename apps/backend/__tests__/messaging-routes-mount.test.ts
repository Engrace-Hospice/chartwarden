// apps/backend/__tests__/messaging-routes-mount.test.ts — FB-T04 composition-root mount glue.
//
// Proves `mountMessagingRoutes(app, db)` wires the M36 messaging surface onto the host behind the
// same auth/security chain as every other module route — so the staff-messaging + notifications-inbox
// screens reach live endpoints instead of 404s. Route REGISTRATION never touches the DB (the Drizzle
// route-service only closes over the handle; queries happen at request time), so a stub DbClient
// exercises the wiring without live Postgres. The deep route behavior is covered by the route
// inventory tests over the in-memory service (messaging-routes.test.ts) and the live RLS suite.
import type { DbClient } from "@wardenx/db";
import { resetAbacRegistry, resetAuthorizationContract, resetRbacEngine } from "@wardenx/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountMessagingRoutes } from "../src/modules/36-messaging/index";

// A handle that is never queried during registration — passing it proves the mount glue is pure.
const STUB_DB = {} as DbClient;

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

describe("FB-T04 mountMessagingRoutes (composition-root glue)", () => {
  it("mounts the channel list behind the auth chain (401 unauthenticated, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountMessagingRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/messaging/channels" });
    expect(res.statusCode).toBe(401); // route exists + is gated; a 404 would mean it never mounted
    await app.close();
  });

  it("mounts the alert inbox behind the auth chain (401, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountMessagingRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/alerts/inbox" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("is idempotent — mounting twice does not throw on the single-owner ABAC registry", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountMessagingRoutes(app, STUB_DB);
    // a second mount on a fresh server must not double-register `channel_visibility` and throw
    const app2 = buildServer({ security: { rateLimitEnabled: false } });
    expect(() => mountMessagingRoutes(app2, STUB_DB)).not.toThrow();
    await app.close();
    await app2.close();
  });

  it("does not serve the routes when the mount hook is not invoked (404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const res = await app.inject({ method: "GET", url: "/api/v1/messaging/channels" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
