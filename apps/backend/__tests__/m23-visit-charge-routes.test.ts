// apps/backend/__tests__/m23-visit-charge-routes.test.ts — HTTP-layer smoke for the tenant-entered hospice visit-charge
// schedule routes (`/api/v1/billing/visit-charge-schedules`), over the REAL Authorization Contract and an in-memory
// `VisitChargeRouteService` (the m23-rate-table-routes.test.ts precedent). What this proves that the live suite (which
// drives the service directly) cannot: the permission keys are the right ones, a read-only holder cannot write, the
// AI-block and `Idempotency-Key` guards are composed, the §4.7 provider-scope predicate gates by the body/query
// provider entity, and the TypeBox validators reject a malformed body as a 4xx before the service runs.
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
import type { VisitChargeRouteService } from "../src/modules/23-billing-medicare/routes/visit-charge-service";
import type { VisitChargeView } from "../src/modules/23-billing-medicare/routes/visit-charge-typebox";
import { registerVisitChargeRoutes } from "../src/modules/23-billing-medicare/routes/visit-charge.routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const PE = "77777777-7777-4777-8777-777777777777";
const OTHER_PE = "99999999-9999-4999-8999-999999999999";
const VC = "12121212-1212-4212-8212-121212121212";
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

const VIEW: VisitChargeView = {
  visitChargeScheduleId: VC,
  organizationId: ORG,
  providerEntityId: PE,
  effectiveFrom: "2026-10-01",
  effectiveTo: null,
  rnUnitChargeCents: 2_500,
  lpnUnitChargeCents: null,
  aideUnitChargeCents: 1_500,
  mswUnitChargeCents: 0,
  ptUnitChargeCents: null,
  otUnitChargeCents: null,
  slpUnitChargeCents: null,
  enteredByMembershipId: MEMBERSHIP,
  entryReason: null,
  supersededAt: null,
  supersededById: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

const BODY = {
  providerEntityId: PE,
  effectiveFrom: "2026-10-01",
  rnUnitChargeCents: 2_500,
  aideUnitChargeCents: 1_500,
  mswUnitChargeCents: 0,
};

function fakeService() {
  const calls: string[] = [];
  const service: VisitChargeRouteService = {
    async createVisitCharge(_actor, body) {
      calls.push(`create:${body.providerEntityId}`);
      return { ...VIEW, providerEntityId: body.providerEntityId };
    },
    async supersedeVisitCharge(_actor, id) {
      calls.push(`supersede:${id}`);
      return { ...VIEW, visitChargeScheduleId: "34343434-3434-4434-8434-343434343434" };
    },
    async listVisitCharges() {
      return [VIEW];
    },
    async getVisitCharge(_actor, _pe, id) {
      if (id !== VC) throw new NotFoundError("visit-charge schedule");
      return VIEW;
    },
    async effectiveVisitCharge() {
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
        grants: perms(["billing.visit_charge.read", "billing.visit_charge.admin"]),
      },
      { orgId: ORG, userId: "reader_1", grants: perms(["billing.visit_charge.read"]) },
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
  registerVisitChargeRoutes(app, { visitChargeService: service });
  return { app, calls };
}

const ADMIN = { "x-test-user": "admin_1", "x-test-roles": "org_admin" };
const READER = { "x-test-user": "reader_1", "x-test-roles": "billing_manager" };
const NONE = { "x-test-user": "none_1", "x-test-roles": "" };
let idemCounter = 0;
// a fresh key per call: the idempotency layer replays a stored response for a repeated key
const idem = () => ({ "idempotency-key": `vc-${++idemCounter}` });
const BASE = "/api/v1/billing/visit-charge-schedules";

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

describe("M23 visit-charge schedule routes", () => {
  it("401s without a session and 403s a session with no visit-charge grant", async () => {
    const { app } = makeServer();
    const url = `${BASE}?providerEntityId=${PE}`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: NONE })).statusCode).toBe(403);
    await app.close();
  });

  it("a read-only holder can list / get / look up, but cannot create or supersede (403)", async () => {
    const { app, calls } = makeServer();
    const q = `providerEntityId=${PE}`;
    for (const url of [
      `${BASE}?${q}`,
      `${BASE}/${VC}?${q}`,
      `${BASE}/effective?${q}&onDate=2026-11-01`,
    ]) {
      expect((await app.inject({ method: "GET", url, headers: READER })).statusCode).toBe(200);
    }
    const create = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...READER, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(403);
    const sup = await app.inject({
      method: "POST",
      url: `${BASE}/${VC}/supersede`,
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
      url: BASE,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().visitChargeScheduleId).toBe(VC);
    const sup = await app.inject({
      method: "POST",
      url: `${BASE}/${VC}/supersede`,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(sup.statusCode).toBe(201);
    expect(calls).toEqual([`create:${PE}`, `supersede:${VC}`]);
    await app.close();
  });

  it("requires an Idempotency-Key on both mutations", async () => {
    const { app, calls } = makeServer();
    expect(
      (await app.inject({ method: "POST", url: BASE, headers: ADMIN, payload: BODY })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${BASE}/${VC}/supersede`,
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
      url: BASE,
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
      url: `${BASE}?providerEntityId=${OTHER_PE}`,
      headers: ADMIN,
    });
    expect(read.statusCode).toBe(404);
    const write = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...ADMIN, ...idem() },
      payload: { ...BODY, providerEntityId: OTHER_PE },
    });
    expect(write.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });

  it.each([
    ["a non-integer cents value", { rnUnitChargeCents: 25.5 }],
    ["a negative charge", { rnUnitChargeCents: -1 }],
    ["a charge above the plausible band", { rnUnitChargeCents: 100_001 }],
    ["a malformed date", { effectiveFrom: "10/01/2026" }],
    ["a non-uuid provider entity", { providerEntityId: "not-a-uuid" }],
  ])("rejects %s before the service runs", async (_name, over) => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...ADMIN, ...idem() },
      payload: { ...BODY, ...over },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("404s an unknown schedule id", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/56565656-5656-4656-8656-565656565656?providerEntityId=${PE}`,
      headers: READER,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
