// apps/backend/__tests__/m23-clearinghouse-attempt-routes.test.ts — HTTP-layer proof of the clearinghouse attempt
// resolution route (ADR-0053) over the REAL Authorization Contract (RBAC + the real `provider_entity_billing_scope`
// predicate + step-up) and a recording service: the permission key guards the route, it needs the step-up, an
// out-of-scope provider entity is refused, the AI-block and Idempotency-Key guards are composed, a malformed body is
// refused before the service runs, and the org and acting user come from the session, never the body.
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
import { registerClearinghouseAttemptRoutes } from "../src/modules/23-billing-medicare/routes/clearinghouse-attempt.routes";
import type { ClearinghouseAttemptResolutionService } from "../src/modules/23-billing-medicare/services/clearinghouse-attempt-resolution-service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const PE_IN = "77777777-7777-4777-8777-777777777777";
const PE_OUT = "88888888-8888-4888-8888-888888888888";
const MEMBERSHIP = "abababab-abab-4bab-8bab-abababababab";

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

const resolver: ReadingM23AbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadNoe() {
    return null;
  },
  async loadNotr() {
    return null;
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
  const calls: Array<{ organizationId: string; userId: string; input: unknown }> = [];
  const service: ClearinghouseAttemptResolutionService = {
    async resolveStale(actor, input) {
      calls.push({ ...actor, input });
      return {
        idempotencyKey: input.idempotencyKey,
        controlNumber: "000000001",
        status: input.outcome === "sent" ? "sent" : "voided",
        clearinghouseSubmissionId:
          input.outcome === "sent" ? input.clearinghouseSubmissionId : null,
      };
    },
  };
  const grant = (userId: string, keys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grant("admin_1", ["billing.clearinghouse.resolve_attempt"]),
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
  registerClearinghouseAttemptRoutes(app, { resolutionService: service });
  return { app, calls };
}

const ADMIN = {
  "x-test-user": "admin_1",
  "x-test-roles": "billing_manager",
  "x-test-pe": PE_IN,
  "x-test-step-up": "1",
};
const NONE = { "x-test-user": "none_1", "x-test-roles": "" };
let idemCounter = 0;
const idem = () => ({ "idempotency-key": `ch-${++idemCounter}` });
const URL = "/api/v1/billing/clearinghouse-attempts/resolve";
const RELEASE = {
  providerEntityId: PE_IN,
  usage: "test",
  idempotencyKey: "idem-1",
  outcome: "not_filed",
  confirmedAtVendor: true,
};

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

describe("M23 clearinghouse attempt resolution route (ADR-0053)", () => {
  it("401s without a session and 403s one without the permission", async () => {
    const { app } = makeServer();
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: URL,
        headers: { ...headers, ...idem() },
        payload: RELEASE,
      });
    expect((await post({})).statusCode).toBe(401);
    expect((await post(NONE)).statusCode).toBe(403);
    await app.close();
  });

  it("needs a recent step-up", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: { ...ADMIN, "x-test-step-up": "0", ...idem() },
      payload: RELEASE,
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("refuses a provider entity outside the actor's reach", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: { ...ADMIN, "x-test-pe": PE_OUT, ...idem() },
      payload: RELEASE,
    });
    expect([403, 404]).toContain(res.statusCode);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("refuses an AI principal and a request without an Idempotency-Key", async () => {
    const { app, calls } = makeServer();
    const ai = await app.inject({
      method: "POST",
      url: URL,
      headers: { ...ADMIN, "x-test-actor-kind": "ai_agent", ...idem() },
      payload: RELEASE,
    });
    expect(ai.statusCode).toBe(403);
    const noKey = await app.inject({ method: "POST", url: URL, headers: ADMIN, payload: RELEASE });
    expect(noKey.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("refuses a malformed body before the service runs", async () => {
    const { app, calls } = makeServer();
    for (const payload of [
      { ...RELEASE, outcome: "sent" }, // sent needs the vendor id
      { ...RELEASE, idempotencyKey: "has space" },
      { ...RELEASE, usage: "staging" },
      { ...RELEASE, outcome: "other" },
      { ...RELEASE, confirmedAtVendor: false },
      { ...RELEASE, outcome: "sent", clearinghouseSubmissionId: "has space" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: { ...ADMIN, ...idem() },
        payload,
      });
      expect(res.statusCode).toBe(422);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("settles through the service as the session's org and user, never the body's", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: { ...ADMIN, ...idem() },
      payload: {
        ...RELEASE,
        organizationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        outcome: "sent",
        clearinghouseSubmissionId: "ch-1",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "sent", clearinghouseSubmissionId: "ch-1" });
    expect(calls).toEqual([expect.objectContaining({ organizationId: ORG, userId: "admin_1" })]);
    await app.close();
  });
});
