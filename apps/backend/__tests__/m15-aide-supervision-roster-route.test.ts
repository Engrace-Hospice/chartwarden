// apps/backend/__tests__/m15-aide-supervision-roster-route.test.ts — `GET /api/v1/discipline-plans/:planId/
// aide-supervision-roster`, the staff picker behind the Aide POC supervisory-visit modal. An RN holding only
// `discipline_plan.read` must be able to call it (the org-admin member list is not reachable for an RN); the
// plan scope is the read service's (an unknown, cross-tenant, off-caseload or non-aide plan is one 404);
// and the body is exactly `{ aides, supervisors }` of `{ membershipId, displayName, roleKey }`.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountM15Routes } from "../src/modules/15-discipline-care-plans/index";
import type {
  AideSupervisionRosterView,
  M15ReadService,
  M15WriteService,
} from "../src/modules/15-discipline-care-plans/routes/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";
const MISSING_PLAN = "99999999-9999-4999-8999-999999999999";
const AIDE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ROSTER: AideSupervisionRosterView = {
  aides: [{ membershipId: AIDE, displayName: "Avery Aide", roleKey: "chha" }],
  supervisors: [{ membershipId: RN, displayName: "Riley Nurse", roleKey: "rn" }],
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["rn"];
}

function makeServer(planRoster: Record<string, AideSupervisionRosterView | null>) {
  const calls: string[] = [];
  const readService = {
    getAideSupervisionRoster: async (_actor: unknown, planId: string) => {
      calls.push(planId);
      return planRoster[planId] ?? null;
    },
  } as unknown as M15ReadService;
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "rn_reader",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["discipline_plan.read"],
          },
        ],
      },
      { orgId: ORG, userId: "no_grants", grants: [] },
    ]).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM15Routes(app, { readService, writeService: {} as M15WriteService });
  return { app, calls };
}

const url = (planId: string) => `/api/v1/discipline-plans/${planId}/aide-supervision-roster`;

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

describe("GET /api/v1/discipline-plans/:planId/aide-supervision-roster", () => {
  it("answers an RN holding only discipline_plan.read with the roster body", async () => {
    const { app, calls } = makeServer({ [PLAN]: ROSTER });
    const res = await app.inject({
      method: "GET",
      url: url(PLAN),
      headers: { "x-test-user": "rn_reader" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ROSTER);
    expect(calls).toEqual([PLAN]);
    await app.close();
  });

  it("refuses a caller without discipline_plan.read before the read service runs", async () => {
    const { app, calls } = makeServer({ [PLAN]: ROSTER });
    const res = await app.inject({
      method: "GET",
      url: url(PLAN),
      headers: { "x-test-user": "no_grants" },
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("answers an unknown, cross-tenant or off-scope plan (service says null) with a plain 404", async () => {
    const { app } = makeServer({ [PLAN]: ROSTER });
    const res = await app.inject({
      method: "GET",
      url: url(MISSING_PLAN),
      headers: { "x-test-user": "rn_reader" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty("aides");
    await app.close();
  });

  it("rejects a malformed plan id before the read service runs", async () => {
    const { app, calls } = makeServer({ [PLAN]: ROSTER });
    const res = await app.inject({
      method: "GET",
      url: url("not-a-uuid"),
      headers: { "x-test-user": "rn_reader" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);
    await app.close();
  });
});
