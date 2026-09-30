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
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { SequestrationPolicyRouteService } from "../src/modules/23-billing-medicare/routes/sequestration-policy-service";
import type { SequestrationPolicyView } from "../src/modules/23-billing-medicare/routes/sequestration-policy-typebox";
import { registerSequestrationPolicyRoutes } from "../src/modules/23-billing-medicare/routes/sequestration-policy.routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const PE = "77777777-7777-4777-8777-777777777777";
const OTHER_PE = "99999999-9999-4999-8999-999999999999";
const POL = "12121212-1212-4212-8212-121212121212";
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

const VIEW: SequestrationPolicyView = {
  policyId: POL,
  organizationId: ORG,
  providerEntityId: PE,
  percentage: "2.00",
  effectiveFrom: "2022-07-01",
  effectiveTo: null,
  setByMembershipId: MEMBERSHIP,
  setReason: null,
  supersededAt: null,
  supersededById: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const BODY = { providerEntityId: PE, percentage: "2.00", effectiveFrom: "2022-07-01" };

function fakeService() {
  const calls: string[] = [];
  const service: SequestrationPolicyRouteService = {
    async createPolicy(_actor, body) {
      calls.push(`create:${body.providerEntityId}`);
      return { ...VIEW, providerEntityId: body.providerEntityId };
    },
    async supersedePolicy(_actor, id) {
      calls.push(`supersede:${id}`);
      return { ...VIEW, policyId: "34343434-3434-4434-8434-343434343434" };
    },
    async listPolicies() {
      return [VIEW];
    },
    async getPolicy(_actor, _pe, id) {
      if (id !== POL) throw new NotFoundError("sequestration policy");
      return VIEW;
    },
    async activePolicy() {
      return VIEW;
    },
    async effectivePolicy() {
      return null;
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
        grants: perms(["billing.sequestration_policy.read", "billing.sequestration_policy.edit"]),
      },
      { orgId: ORG, userId: "reader_1", grants: perms(["billing.sequestration_policy.read"]) },
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
  registerSequestrationPolicyRoutes(app, { sequestrationService: service });
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

const BASE = "/api/v1/billing/sequestration-policies";

describe("M23 sequestration-policy routes (F-212)", () => {
  it("401s without a session and 403s a session with no sequestration grant", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: `${BASE}?providerEntityId=${PE}` })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: `${BASE}?providerEntityId=${PE}`, headers: NONE }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });

  it("a read-only holder can list / active / effective / get, but cannot create or supersede (403)", async () => {
    const { app, calls } = makeServer();
    const q = `providerEntityId=${PE}`;
    expect(
      (await app.inject({ method: "GET", url: `${BASE}?${q}`, headers: READER })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `${BASE}/active?${q}`, headers: READER })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${BASE}/effective?${q}&onDate=2026-02-01`,
          headers: READER,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `${BASE}/${POL}?${q}`, headers: READER })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: BASE,
          headers: { ...READER, ...idem() },
          payload: BODY,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${BASE}/${POL}/supersede`,
          headers: { ...READER, ...idem() },
          payload: BODY,
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("an editor creates (201) and supersedes (201)", async () => {
    const { app, calls } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: BASE,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().policyId).toBe(POL);
    const sup = await app.inject({
      method: "POST",
      url: `${BASE}/${POL}/supersede`,
      headers: { ...ADMIN, ...idem() },
      payload: BODY,
    });
    expect(sup.statusCode).toBe(201);
    expect(calls).toEqual([`create:${PE}`, `supersede:${POL}`]);
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
          url: `${BASE}/${POL}/supersede`,
          headers: ADMIN,
          payload: BODY,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("refuses an AI principal on both mutations (D13)", async () => {
    const { app, calls } = makeServer();
    const ai = { ...ADMIN, "x-test-actor-kind": "ai_agent" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: BASE,
          headers: { ...ai, ...idem() },
          payload: BODY,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${BASE}/${POL}/supersede`,
          headers: { ...ai, ...idem() },
          payload: BODY,
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("gates by the provider entity: an out-of-scope entity 404s on read and write", async () => {
    const { app, calls } = makeServer();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${BASE}?providerEntityId=${OTHER_PE}`,
          headers: ADMIN,
        })
      ).statusCode,
    ).toBe(404);
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
    ["a non-decimal percentage", { percentage: "two" }],
    ["a negative percentage", { percentage: "-1" }],
    ["a missing percentage", { percentage: undefined }],
    ["a malformed date", { effectiveFrom: "07/01/2022" }],
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

  it("404s an unknown policy id", async () => {
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
