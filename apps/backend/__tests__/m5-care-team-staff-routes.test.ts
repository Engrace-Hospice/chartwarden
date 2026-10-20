// apps/backend/__tests__/m5-care-team-staff-routes.test.ts — GET /api/v1/orgs/:id/care-team-staff, the
// narrow read-only staff lookup behind the care-team assign dialog. Route layer only: permission
// (patient.assign, i.e. exactly who may POST an assignment), org binding, allowlisted payload, q/limit.
// The Drizzle port is proven live in m5-care-team-staff.live.test.ts.
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type {
  CareTeamStaffPort,
  CareTeamStaffView,
} from "../src/modules/05-patient/care-team-staff";
import { registerCareTeamStaffRoutes } from "../src/modules/05-patient/routes/care-team-staff-routes";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["rn"];
}

const ORG = "org_a";
const PERMISSION_SEED = [
  { userId: "assigner_1", permissions: ["patient.read", "patient.assign"] },
  { userId: "reader_1", permissions: ["patient.read"] },
];
const ASSIGNER = { "x-test-user": "assigner_1", "x-test-org": ORG };
const READER = { "x-test-user": "reader_1", "x-test-org": ORG };

const STAFF: CareTeamStaffView = {
  userId: "5f1c0b2e-6a43-4d0e-9a53-0d6c1f9a7b11",
  membershipId: "7a1c0b2e-6a43-4d0e-9a53-0d6c1f9a7b22",
  displayName: "Rosa Nurse",
  roleLabels: ["Registered Nurse"],
};

function makeServer() {
  const calls: { organizationId: string; q?: string; limit: number }[] = [];
  const port: CareTeamStaffPort = {
    async search(organizationId, query) {
      calls.push({ organizationId, ...query });
      // A leaky adapter must still not reach the wire: the route re-projects to the allowlist.
      return [{ ...STAFF, email: "rosa@example.org", phone: "555-0100" } as CareTeamStaffView];
    },
  };
  const grants = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grants.store);
  registerAbacRegistry();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerCareTeamStaffRoutes(app, { staff: port });
  return { app, calls };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

const GET = (headers: Record<string, string>, url = `/api/v1/orgs/${ORG}/care-team-staff`) => ({
  method: "GET" as const,
  url,
  headers,
});

describe("GET /orgs/:id/care-team-staff", () => {
  it("returns only the allowlisted fields for a holder of patient.assign", async () => {
    const { app } = makeServer();
    const res = await app.inject(GET(ASSIGNER));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ staff: [STAFF] });
    expect(res.body).not.toContain("rosa@example.org");
    expect(res.body).not.toContain("555-0100");
    await app.close();
  });

  it("denies a patient.read-only holder (403)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(GET(READER));
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("denies a path org that is not the caller's bound org (403) without querying", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(GET(ASSIGNER, "/api/v1/orgs/org_b/care-team-staff"));
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("passes the bound org, a trimmed q and a default bounded limit to the port", async () => {
    const { app, calls } = makeServer();
    await app.inject(GET(ASSIGNER, `/api/v1/orgs/${ORG}/care-team-staff?q=%20rosa%20`));
    expect(calls).toEqual([{ organizationId: ORG, q: "rosa", limit: 25 }]);
    await app.close();
  });

  it("honours an explicit limit and rejects one above the cap (422)", async () => {
    const { app, calls } = makeServer();
    await app.inject(GET(ASSIGNER, `/api/v1/orgs/${ORG}/care-team-staff?limit=10`));
    expect(calls[0]?.limit).toBe(10);
    const res = await app.inject(GET(ASSIGNER, `/api/v1/orgs/${ORG}/care-team-staff?limit=500`));
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
