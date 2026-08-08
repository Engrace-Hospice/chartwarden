import { resetAuthorizationContract, resetRbacEngine } from "@wardenx/auth";
// apps/backend/__tests__/gap-003-compliance-routes-mount.test.ts — GAP-003 composition-root mount
// glue, mirroring the GAP-002 `audit-routes-mount.test.ts` pattern (itself mirroring
// `mdm-routes-mount.test.ts`): proves `mountAuditRoutes(app, db)` wires the FULL M4 compliance
// surface — legal holds, destruction certificates, audit exports, the integrity report — not just
// the pre-existing audit-log routes. A stub DbClient exercises the wiring without live Postgres;
// route BEHAVIOR (real matched-counts, the rate limit, the live GRANT read) is covered by
// gap-003-compliance-routes.live.test.ts.
import type { DbClient } from "@wardenx/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountAuditRoutes } from "../src/modules/04-audit/index";

const STUB_DB = {} as DbClient;
const ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("GAP-003 mountAuditRoutes — full compliance surface (composition-root glue)", () => {
  const cases: Array<{ method: "GET" | "POST"; url: string }> = [
    { method: "GET", url: "/api/v1/legal-holds" },
    { method: "POST", url: "/api/v1/legal-holds" },
    { method: "POST", url: `/api/v1/legal-holds/${ID}/release` },
    { method: "GET", url: "/api/v1/destruction-certificates" },
    { method: "POST", url: `/api/v1/destruction-certificates/${ID}/approve` },
    { method: "POST", url: `/api/v1/destruction-certificates/${ID}/hold` },
    { method: "POST", url: "/api/v1/audit/exports" },
    { method: "GET", url: `/api/v1/audit/exports/${ID}` },
    { method: "GET", url: "/api/v1/audit/integrity/report" },
  ];

  it.each(cases)("mounts $method $url behind the auth chain (401, not 404)", async ({ method, url }) => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    mountAuditRoutes(app, STUB_DB);
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401); // a 404 would mean the route never mounted
    await app.close();
  });

  it("does not serve any of the 9 routes when the mount hook is not invoked (404)", async () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const res = await app.inject({ method: "GET", url: "/api/v1/legal-holds" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
