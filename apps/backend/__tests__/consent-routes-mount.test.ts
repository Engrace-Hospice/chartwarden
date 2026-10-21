import { resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
// apps/backend/__tests__/consent-routes-mount.test.ts — FB-T03 composition-root mount glue.
//
// Proves `mountConsentRoutes(app, db)` wires the M39 consent surface onto the host behind the same
// auth/security chain as every other module route — so the Patient Chart consent tab reaches a live
// endpoint instead of a 404. Route REGISTRATION never touches the DB (the Drizzle store only closes
// over the handle; queries happen at request time), so a stub DbClient exercises the wiring without
// live Postgres. The deep store reads are covered by the route inventory tests over the in-memory
// backend (consent-routes.test.ts) and the live RLS suite (rls-isolation.live.test.ts).
import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountConsentRoutes } from "../src/modules/39-consent/index";

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

describe("FB-T03 mountConsentRoutes (composition-root glue)", () => {
  it("mounts the patient-consents read surface behind the auth chain (401 unauthenticated, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountConsentRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/p1/consents" });
    expect(res.statusCode).toBe(401); // route exists + is gated; a 404 would mean it never mounted
    await app.close();
  });

  it("mounts the consent-type catalog behind the auth chain (401, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountConsentRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/consent-types" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("does not serve the routes when the mount hook is not invoked (404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/p1/consents" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
