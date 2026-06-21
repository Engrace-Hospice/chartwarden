// apps/backend/__tests__/mdm-routes-mount.test.ts — FB-T02 composition-root mount glue.
//
// Proves `mountMdmRoutes(app, db)` wires the M40 MDM surface onto the host behind the same
// auth/security chain as every other module route — so the MDM console reaches a live endpoint
// instead of a 404. Route REGISTRATION never touches the DB (the Drizzle stores only close over the
// handle; queries happen at request time), so a stub DbClient exercises the wiring without live
// Postgres. The deep store reads/writes are covered by the route inventory tests over the in-memory
// backend (mdm-routes.test.ts) and by the live RLS suite (rls-isolation.live.test.ts).
import type { DbClient } from "@wardenx/db";
import { resetAuthorizationContract, resetRbacEngine } from "@wardenx/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountMdmRoutes } from "../src/modules/40-mdm/index";

// A handle that is never queried during registration — passing it proves the mount glue is pure.
const STUB_DB = {} as DbClient;

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("FB-T02 mountMdmRoutes (composition-root glue)", () => {
  it("mounts the entity-directory read surface behind the auth chain (401 unauthenticated, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountMdmRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/mdm/physician/search?q=smith" });
    expect(res.statusCode).toBe(401); // route exists + is gated; a 404 would mean it never mounted
    await app.close();
  });

  it("mounts the platform-ops merge surface behind the auth chain (401, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountMdmRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/mdm/merge-requests" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("does not serve the routes when the mount hook is not invoked (404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const res = await app.inject({ method: "GET", url: "/api/v1/mdm/physician/search?q=smith" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
