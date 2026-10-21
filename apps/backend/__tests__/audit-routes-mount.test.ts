import { resetAuthorizationContract, resetRbacEngine } from "@chartwarden/auth";
// apps/backend/__tests__/audit-routes-mount.test.ts — GAP-002 composition-root mount glue.
//
// Proves `mountAuditRoutes(app, db)` wires BOTH the M4 audit-log query surface and the §164.528/
// §2.13 patient accounting-of-disclosures route onto the host. Before this fix,
// `registerPatientAccountingRoute` was exported from the module barrel and unit-tested in
// isolation (audit-accounting.test.ts), but `mountAuditRoutes` — the only function the real
// composition root (apps/backend/src/index.ts) ever calls — never invoked it, so the route was
// permanently unreachable in prod/dev despite every other gate reading green. Route REGISTRATION
// never touches the DB (the Drizzle query/executor only close over the handle; queries happen at
// request time), so a stub DbClient exercises the wiring without live Postgres.
import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountAuditRoutes } from "../src/modules/04-audit/index";

// A handle that is never queried during registration — passing it proves the mount glue is pure.
const STUB_DB = {} as DbClient;
const PATIENT = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("GAP-002 mountAuditRoutes (composition-root glue)", () => {
  it("mounts the audit-event search route behind the auth chain (401, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountAuditRoutes(app, STUB_DB);
    const res = await app.inject({ method: "GET", url: "/api/v1/audit/events" });
    expect(res.statusCode).toBe(401); // route exists + is gated; a 404 would mean it never mounted
    await app.close();
  });

  it("mounts the §164.528/§2.13 patient accounting route behind the auth chain (401, not 404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountAuditRoutes(app, STUB_DB);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit/patients/${PATIENT}/accounting`,
    });
    expect(res.statusCode).toBe(401); // was a permanent 404 pre-fix — GAP-002
    await app.close();
  });

  it("does not serve either route when the mount hook is not invoked (404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit/patients/${PATIENT}/accounting`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
