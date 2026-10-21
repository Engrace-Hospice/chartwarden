// apps/backend/__tests__/m23-rate-table-routes.test.ts — F-210 HTTP-layer smoke for the tenant-entered hospice rate
// table routes (`/api/v1/billing/rate-tables`), over the REAL Authorization Contract and an in-memory
// `RateTableRouteService` (the `billing-medicare-inject.test.ts` precedent). What this proves that the live suite
// (which drives the service directly) cannot: the permission keys are the right ones, a read-only holder cannot
// write, the AI-block and `Idempotency-Key` guards are composed, the §4.7 provider-scope predicate gates by the
// body/query provider entity, and the TypeBox validators reject a malformed body as a 4xx before the service runs.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { RateTableRouteService } from "../src/modules/23-billing-medicare/routes/rate-table-service";
import type { RateTableView } from "../src/modules/23-billing-medicare/routes/rate-table-typebox";
import { registerRateTableRoutes } from "../src/modules/23-billing-medicare/routes/rate-table.routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const PE = "77777777-7777-4777-8777-777777777777";
const OTHER_PE = "99999999-9999-4999-8999-999999999999";
const RT = "12121212-1212-4212-8212-121212121212";
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

const VIEW: RateTableView = {
  rateTableId: RT,
  organizationId: ORG,
  providerEntityId: PE,
  fiscalYearStarting: 2025,
  effectiveFrom: "2025-10-01",
  effectiveTo: "2026-09-30",
  rhcDays1to60PerDiemCents: 21_500,
  rhcDays61PlusPerDiemCents: 17_000,
  chcPerDiemCents: 105_600,
  ircPerDiemCents: 49_000,
  gipPerDiemCents: 118_000,
  chcHourlyRateCents: 4_400,
  laborShareRhc: "0.6600",
  laborShareChc: "0.6800",
  laborShareIrc: "0.5400",
  laborShareGip: "0.6400",
  hqrpCompliant: null,
  nationalReferenceWarnings: [],
  enteredByMembershipId: MEMBERSHIP,
  entryReason: null,
  supersededAt: null,
  supersededById: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const BODY = {
  providerEntityId: PE,
  fiscalYearStarting: 2025,
  effectiveFrom: "2025-10-01",
  rhcDays1to60PerDiemCents: 21_500,
  rhcDays61PlusPerDiemCents: 17_000,
  chcPerDiemCents: 105_600,
  ircPerDiemCents: 49_000,
  gipPerDiemCents: 118_000,
  chcHourlyRateCents: 4_400,
  laborShareRhc: "0.6600",
  laborShareChc: "0.6800",
  laborShareIrc: "0.5400",
  laborShareGip: "0.6400",
};

function fakeService() {
  const calls: string[] = [];
  const service: RateTableRouteService = {
    async createRateTable(_actor, body) {
      calls.push(`create:${body.providerEntityId}`);
      return { ...VIEW, providerEntityId: body.providerEntityId };
    },
    async supersedeRateTable(_actor, id) {
      calls.push(`supersede:${id}`);
      return { ...VIEW, rateTableId: "34343434-3434-4434-8434-343434343434" };
    },
    async listRateTables() {
      return [VIEW];
    },
    async getRateTable(_actor, _pe, id) {
      if (id !== RT) throw new NotFoundError("rate table");
      return VIEW;
    },
    async effectiveRateTable() {
      return VIEW;
    },
  };
  return { service, calls };
}

function makeServer() {
  const { service, calls } = fakeService();
  const perms = (keys: string[]) => [
    { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys },
  ];
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "admin_1",
        grants: perms(["billing.rate_table.read", "billing.rate_table.admin"]),
      },
      { orgId: ORG, userId: "reader_1", grants: perms(["billing.rate_table.read"]) },
      { orgId: ORG, userId: "none_1", grants: perms([]) },
    ]).store,
  );
  // Stand-in for the M23 `provider_entity_billing_scope` predicate: admit only the provider entity the actor is
  // scoped to (the real one is covered by billing-medicare-inject.test.ts over its resolver).
  const reg = createPredicateRegistry();
  reg.register("provider_entity_billing_scope", async (_context, target) => {
    return (target as { providerEntityId?: string } | undefined)?.providerEntityId === PE;
  });
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerRateTableRoutes(app, { rateTableService: service });
  return { app, calls };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-roles": "org_admin" };
const READER = { "x-test-user": "reader_1", "x-test-roles": "billing_manager" };
const NONE = { "x-test-user": "none_1", "x-test-roles": "" };
let idemCounter = 0;
// a fresh key per call: the idempotency layer replays a stored response for a repeated key
const idem = () => ({ "idempotency-key": `f206-${++idemCounter}` });

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

describe("M23 rate-table routes (F-210)", () => {
  it("401s without a session and 403s a session with no rate-table grant", async () => {
    const { app } = makeServer();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/billing/rate-tables?providerEntityId=${PE}`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/billing/rate-tables?providerEntityId=${PE}`,
          headers: NONE,
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("a read-only holder can list / get / look up, but cannot create or supersede (403)", async () => {
    const { app, calls } = makeServer();
    const q = `providerEntityId=${PE}`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/billing/rate-tables?${q}`,
          headers: READER,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/billing/rate-tables/${RT}?${q}`,
          headers: READER,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/billing/rate-tables/effective?${q}&onDate=2026-02-01`,
          headers: READER,
        })
      ).statusCode,
    ).toBe(200);
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/billing/rate-tables",
      headers: { ...READER, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(403);
    const sup = await app.inject({
      method: "POST",
      url: `/api/v1/billing/rate-tables/${RT}/supersede`,
      headers: { ...READER, ...idem() },
      payload: BODY,
    });
    expect(sup.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("an admin creates (201) and supersedes (201)", async () => {
    const { app, calls } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/billing/rate-tables",
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().rateTableId).toBe(RT);
    const sup = await app.inject({
      method: "POST",
      url: `/api/v1/billing/rate-tables/${RT}/supersede`,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(sup.statusCode).toBe(201);
    expect(calls).toEqual([`create:${PE}`, `supersede:${RT}`]);
    await app.close();
  });

  it("requires an Idempotency-Key on both mutations", async () => {
    const { app, calls } = makeServer();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/billing/rate-tables",
          headers: ADMIN,
          payload: BODY,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/billing/rate-tables/${RT}/supersede`,
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
      url: "/api/v1/billing/rate-tables",
      headers: { ...ADMIN, ...idem(), "x-test-actor-kind": "ai_agent" },
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("gates by the provider entity: an out-of-scope entity 404s (existence-non-leak) on read and write", async () => {
    const { app, calls } = makeServer();
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/billing/rate-tables?providerEntityId=${OTHER_PE}`,
      headers: ADMIN,
    });
    expect(read.statusCode).toBe(404);
    const write = await app.inject({
      method: "POST",
      url: "/api/v1/billing/rate-tables",
      headers: { ...ADMIN, ...idem() },
      payload: { ...BODY, providerEntityId: OTHER_PE },
    });
    expect(write.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });

  it.each([
    ["a non-integer cents value", { rhcDays1to60PerDiemCents: 215.5 }],
    ["a zero rate", { gipPerDiemCents: 0 }],
    ["a missing required rate", { chcHourlyRateCents: undefined }],
    ["a missing labor share", { laborShareRhc: undefined }],
    ["a labor share keyed as a percent", { laborShareChc: "68.71" }],
    ["a malformed date", { effectiveFrom: "10/01/2025" }],
    ["a non-uuid provider entity", { providerEntityId: "not-a-uuid" }],
  ])("rejects %s before the service runs", async (_name, over) => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/rate-tables",
      headers: { ...ADMIN, ...idem() },
      payload: { ...BODY, ...over },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("404s an unknown rate table id", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/billing/rate-tables/56565656-5656-4656-8656-565656565656?providerEntityId=${PE}`,
      headers: READER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("national-reference: a reader gets the corrected FY2027 CMS rates; an unknown year is null; scope enforced", async () => {
    const { app } = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/billing/rate-tables/national-reference?providerEntityId=${PE}&fiscalYearStarting=2026`,
      headers: READER,
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      reference: {
        fiscalYearLabel: string;
        hqrpCompliant: { rhcDays1to60PerDiemCents: number };
        hqrpNonCompliant: { rhcDays1to60PerDiemCents: number };
      } | null;
    };
    expect(body.reference?.fiscalYearLabel).toBe("FY2027");
    expect(body.reference?.hqrpCompliant.rhcDays1to60PerDiemCents).toBe(23_633);
    expect(body.reference?.hqrpNonCompliant.rhcDays1to60PerDiemCents).toBe(22_709);

    const none = await app.inject({
      method: "GET",
      url: `/api/v1/billing/rate-tables/national-reference?providerEntityId=${PE}&fiscalYearStarting=2019`,
      headers: READER,
    });
    expect(none.statusCode).toBe(200);
    expect((none.json() as { reference: unknown }).reference).toBeNull();

    const otherScope = await app.inject({
      method: "GET",
      url: `/api/v1/billing/rate-tables/national-reference?providerEntityId=${OTHER_PE}&fiscalYearStarting=2026`,
      headers: READER,
    });
    expect(otherScope.statusCode).toBe(404); // existence-non-leak, like every other scoped read
    const noGrant = await app.inject({
      method: "GET",
      url: `/api/v1/billing/rate-tables/national-reference?providerEntityId=${PE}&fiscalYearStarting=2026`,
      headers: NONE,
    });
    expect(noGrant.statusCode).toBe(403);
    await app.close();
  });
});
