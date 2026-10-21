// apps/backend/__tests__/m23-wage-index-routes.test.ts — F-211 HTTP-layer smoke for the tenant-entered wage-index routes
// (`/api/v1/billing/wage-indexes`), over the REAL Authorization Contract and an in-memory `WageIndexRouteService` (the
// `m23-rate-table-routes.test.ts` precedent). What this proves that the live suite (which drives the service directly)
// cannot: the permission keys are the right ones, a read-only holder cannot write, the AI-block and `Idempotency-Key` guards
// are composed, `/effective` is not swallowed by `/:id`, and the TypeBox validators reject a malformed body as a 4xx before the
// service runs.
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { WageIndexRouteService } from "../src/modules/23-billing-medicare/routes/wage-index-service";
import type { WageIndexView } from "../src/modules/23-billing-medicare/routes/wage-index-typebox";
import { registerWageIndexRoutes } from "../src/modules/23-billing-medicare/routes/wage-index.routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const WI = "12121212-1212-4212-8212-121212121212";
const MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

const VIEW: WageIndexView = {
  wageIndexId: WI,
  organizationId: ORG,
  ccn: "381240",
  fiscalYearStarting: 2025,
  cbsaCode: "38900",
  factorDecimal: "1.0342",
  sourceReference: "CMS FY2026 hospice wage index final rule, Table A",
  enteredByMembershipId: MEMBERSHIP,
  entryReason: null,
  supersededAt: null,
  supersededById: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const BODY = {
  ccn: "381240",
  fiscalYearStarting: 2025,
  cbsaCode: "38900",
  factorDecimal: "1.0342",
  sourceReference: "CMS FY2026 hospice wage index final rule, Table A",
};

function makeServer() {
  const calls: string[] = [];
  const service: WageIndexRouteService = {
    async createWageIndex(_actor, body) {
      calls.push(`create:${body.ccn}`);
      return { ...VIEW, ccn: body.ccn };
    },
    async supersedeWageIndex(_actor, id) {
      calls.push(`supersede:${id}`);
      return { ...VIEW, wageIndexId: "34343434-3434-4434-8434-343434343434" };
    },
    async listWageIndexes() {
      return [VIEW];
    },
    async getWageIndex(_actor, id) {
      if (id !== WI) throw new NotFoundError("wage index");
      return VIEW;
    },
    async liveWageIndex() {
      calls.push("live");
      return VIEW;
    },
  };
  const perms = (keys: string[]) => [
    { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys },
  ];
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "admin_1",
        grants: perms(["billing.wage_index.read", "billing.wage_index.admin"]),
      },
      { orgId: ORG, userId: "reader_1", grants: perms(["billing.wage_index.read"]) },
      { orgId: ORG, userId: "none_1", grants: perms([]) },
      // a holder of the RATE-TABLE keys only must not reach the wage-index surface
      {
        orgId: ORG,
        userId: "rate_1",
        grants: perms(["billing.rate_table.read", "billing.rate_table.admin"]),
      },
    ]).store,
  );
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerWageIndexRoutes(app, { wageIndexService: service });
  return { app, calls };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-roles": "org_admin" };
const READER = { "x-test-user": "reader_1", "x-test-roles": "billing_manager" };
const NONE = { "x-test-user": "none_1", "x-test-roles": "" };
const RATE_ONLY = { "x-test-user": "rate_1", "x-test-roles": "org_admin" };
let idemCounter = 0;
const idem = () => ({ "idempotency-key": `f211-${++idemCounter}` });

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

describe("M23 wage-index routes (F-211)", () => {
  it("401s without a session and 403s a session with no wage-index grant (rate-table keys do not help)", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/billing/wage-indexes" })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/billing/wage-indexes", headers: NONE }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/billing/wage-indexes", headers: RATE_ONLY }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });

  it("a read-only holder can list / get / look up, but cannot create or supersede (403)", async () => {
    const { app, calls } = makeServer();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/billing/wage-indexes?ccn=381240",
          headers: READER,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/billing/wage-indexes/${WI}`,
          headers: READER,
        })
      ).statusCode,
    ).toBe(200);
    const eff = await app.inject({
      method: "GET",
      url: "/api/v1/billing/wage-indexes/effective?ccn=381240&fiscalYearStarting=2025",
      headers: READER,
    });
    expect(eff.statusCode).toBe(200);
    expect(calls).toEqual(["live"]); // /effective reached the live lookup, not the by-id handler
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/billing/wage-indexes",
      headers: { ...READER, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(403);
    const sup = await app.inject({
      method: "POST",
      url: `/api/v1/billing/wage-indexes/${WI}/supersede`,
      headers: { ...READER, ...idem() },
      payload: BODY,
    });
    expect(sup.statusCode).toBe(403);
    expect(calls).toEqual(["live"]);
    await app.close();
  });

  it("an admin creates (201) and supersedes (201)", async () => {
    const { app, calls } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/billing/wage-indexes",
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().wageIndexId).toBe(WI);
    const sup = await app.inject({
      method: "POST",
      url: `/api/v1/billing/wage-indexes/${WI}/supersede`,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(sup.statusCode).toBe(201);
    expect(calls).toEqual(["create:381240", `supersede:${WI}`]);
    await app.close();
  });

  it("requires an Idempotency-Key on both mutations", async () => {
    const { app, calls } = makeServer();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/billing/wage-indexes",
          headers: ADMIN,
          payload: BODY,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/billing/wage-indexes/${WI}/supersede`,
          headers: ADMIN,
          payload: BODY,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("refuses an AI principal on the mutations (D13)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/wage-indexes",
      headers: { ...ADMIN, ...idem(), "x-test-actor-kind": "ai_agent" },
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it.each([
    ["a percent-shaped factor", { factorDecimal: "103.42" }],
    ["a numeric (float) factor", { factorDecimal: 1.0342 }],
    ["a missing factor", { factorDecimal: undefined }],
    ["a short CCN", { ccn: "38124" }],
    ["a missing source", { sourceReference: undefined }],
    ["a blank source", { sourceReference: "" }],
    ["a malformed CBSA", { cbsaCode: "abc" }],
    ["a non-integer fiscal year", { fiscalYearStarting: "twenty" }],
  ])("rejects %s before the service runs", async (_name, over) => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/wage-indexes",
      headers: { ...ADMIN, ...idem() },
      payload: { ...BODY, ...over },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("404s an unknown wage index id", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/billing/wage-indexes/56565656-5656-4656-8656-565656565656",
      headers: READER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
