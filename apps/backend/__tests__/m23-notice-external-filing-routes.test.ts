// HTTP-layer proof of the "record the date I filed outside ChartWarden" routes for a NOE and a NOTR (owner decision D4) over the REAL
// Authorization Contract (RBAC + the real `provider_entity_billing_scope` predicate + step-up) and a recording service: the submit
// permission key guards each route, it needs the step-up, an out-of-scope provider entity is refused (404, no existence leak), the
// AI-block and Idempotency-Key guards are composed, the body is strict (a date and nothing else; no free text, no extra keys) and is
// refused before the service runs, and the org, user and membership come from the session, never the body.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM23AbacPredicates } from "../src/modules/23-billing-medicare/abac-predicates";
import type { ReadingM23AbacResolver } from "../src/modules/23-billing-medicare/abac-resolver-drizzle";
import { registerNoeRoutes } from "../src/modules/23-billing-medicare/routes/noe.routes";
import { registerNotrRoutes } from "../src/modules/23-billing-medicare/routes/notr.routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const PE_IN = "77777777-7777-4777-8777-777777777777";
const PE_OUT = "88888888-8888-4888-8888-888888888888";
const MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";
const NOE_IN = "11111111-1111-4111-8111-111111111111";
const NOE_OUT = "22222222-2222-4222-8222-222222222222";
const NOTR_IN = "33333333-3333-4333-8333-333333333333";
const NOTR_OUT = "44444444-4444-4444-8444-444444444444";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  const pe = request.headers["x-test-pe"];
  if (typeof pe === "string" && pe.length > 0) request.context.providerEntityIds = [pe];
  const actorKind = request.headers["x-test-actor-kind"];
  if (typeof actorKind === "string" && actorKind.length > 0) {
    request.context.attributes.actorKind = actorKind;
  }
}

const facts = (entityId: string, providerEntityId: string) => ({
  entityId,
  organizationId: ORG,
  providerEntityId,
  patientId: "99999999-9999-4999-8999-999999999999",
  state: null,
});
const resolver: ReadingM23AbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadNoe(_ctx, id) {
    return id === NOE_IN ? facts(id, PE_IN) : id === NOE_OUT ? facts(id, PE_OUT) : null;
  },
  async loadNotr(_ctx, id) {
    return id === NOTR_IN ? facts(id, PE_IN) : id === NOTR_OUT ? facts(id, PE_OUT) : null;
  },
  async loadDdeWorkItem() {
    return null;
  },
  async loadValidationResult() {
    return null;
  },
  async loadRuleConfig() {
    return null;
  },
};

function makeServer() {
  const calls: Array<{ kind: string; actor: Record<string, unknown>; id: string; args: unknown }> =
    [];
  const view = (id: string) => ({
    id,
    externalFiling: { status: "filed_externally", filedOn: "2026-11-04", recordedAt: "x" },
  });
  const writeService = {
    async recordNoeExternalFiling(actor: Record<string, unknown>, id: string, args: unknown) {
      calls.push({ kind: "noe", actor, id, args });
      return view(id);
    },
    async recordNotrExternalFiling(actor: Record<string, unknown>, id: string, args: unknown) {
      calls.push({ kind: "notr", actor, id, args });
      return view(id);
    },
  };
  const grant = (userId: string, keys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant("biller_1", ["billing.noe.submit", "billing.notr.submit"]),
      grant("reader_1", ["billing.noe.read", "billing.notr.read"]),
      grant("none_1", []),
    ]).store,
  );
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM23AbacPredicates({ resolver, isInCaseload: async () => true }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const deps = { readService: {} as never, writeService: writeService as never };
  registerNoeRoutes(app, deps);
  registerNotrRoutes(app, deps);
  return { app, calls };
}

const BILLER = {
  "x-test-user": "biller_1",
  "x-test-roles": "billing_manager",
  "x-test-pe": PE_IN,
  "x-test-step-up": "1",
};
let idemCounter = 0;
const idem = () => ({ "idempotency-key": `ext-${++idemCounter}` });
const BODY = { filedOn: "2026-11-04" };

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

describe.each([
  ["NOE", "noe", "/api/v1/noe-records", NOE_IN, NOE_OUT],
  ["NOTR", "notr", "/api/v1/notr-records", NOTR_IN, NOTR_OUT],
] as const)("%s record-external-filing route", (_label, kind, base, idIn, idOut) => {
  const url = (id: string) => `${base}/${id}/record-external-filing`;

  it("401s without a session and 403s one without the submit permission", async () => {
    const { app } = makeServer();
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: url(idIn),
        headers: { ...headers, ...idem() },
        payload: BODY,
      });
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ "x-test-user": "none_1", "x-test-roles": "" })).statusCode).toBe(403);
    expect(
      (
        await post({
          "x-test-user": "reader_1",
          "x-test-roles": "billing_manager",
          "x-test-pe": PE_IN,
          "x-test-step-up": "1",
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("needs a recent step-up", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: url(idIn),
      headers: { ...BILLER, "x-test-step-up": "0", ...idem() },
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("answers 404 for a notice of a provider entity outside the actor's reach, and for an unknown one", async () => {
    const { app, calls } = makeServer();
    for (const id of [idOut, "55555555-5555-4555-8555-555555555555"]) {
      const res = await app.inject({
        method: "POST",
        url: url(id),
        headers: { ...BILLER, ...idem() },
        payload: BODY,
      });
      expect(res.statusCode).toBe(404);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("refuses an AI principal and a request without an Idempotency-Key", async () => {
    const { app, calls } = makeServer();
    const ai = await app.inject({
      method: "POST",
      url: url(idIn),
      headers: { ...BILLER, "x-test-actor-kind": "ai_agent", ...idem() },
      payload: BODY,
    });
    expect(ai.statusCode).toBe(403);
    const noKey = await app.inject({
      method: "POST",
      url: url(idIn),
      headers: BILLER,
      payload: BODY,
    });
    expect(noKey.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("takes a date and nothing else: free text, extra keys, other formats and a non-uuid id never reach the service", async () => {
    const { app, calls } = makeServer();
    for (const payload of [
      {},
      { filedOn: "11/04/2026" },
      { filedOn: "2026-11-04T10:00:00Z" },
      { filedOn: 20261104 },
      { filedOn: "2026-11-04", note: "faxed by Jane Doe" },
      { filedOn: "2026-11-04", organizationId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: url(idIn),
        headers: { ...BILLER, ...idem() },
        payload,
      });
      expect(res.statusCode).toBe(422);
    }
    const badId = await app.inject({
      method: "POST",
      url: url("not-a-uuid"),
      headers: { ...BILLER, ...idem() },
      payload: BODY,
    });
    expect(badId.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("records as the session's org, user and membership with a 200, and answers with the notice view", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: url(idIn),
      headers: { ...BILLER, ...idem() },
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: idIn,
      externalFiling: { status: "filed_externally", filedOn: "2026-11-04" },
    });
    expect(calls).toEqual([
      {
        kind,
        actor: expect.objectContaining({
          organizationId: ORG,
          userId: "biller_1",
          membershipId: MEMBERSHIP,
        }),
        id: idIn,
        args: { filedOn: "2026-11-04" },
      },
    ]);
    await app.close();
  });
});
