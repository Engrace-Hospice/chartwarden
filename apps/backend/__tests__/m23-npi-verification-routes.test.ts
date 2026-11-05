// apps/backend/__tests__/m23-npi-verification-routes.test.ts — the platform NPI-verification admin routes (ADR-0053
// amendment precondition 2) through Fastify `.inject()` on the real M1 host, the real Authorization Contract and the real
// `platform_billing_scope` predicate. The service is a recording fake: this file proves the guards and the actor/body
// binding; `test:m23:claimmd-webhook:live` proves the data, the grants and the sweep.
import { randomUUID } from "node:crypto";
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
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import type {
  NpiVerificationService,
  NpiVerificationView,
} from "../src/modules/23-billing-medicare/routes/npi-verification-service";
import { registerNpiVerificationRoutes } from "../src/modules/23-billing-medicare/routes/npi-verification.routes";
import { buildM35AbacPredicates } from "../src/modules/35-subscription/index";

const ORG = "org_platform";
const PE = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "99999999-9999-4999-8999-999999999999";
const KEY = "billing.rule_config.platform_admin";
const LIST = "/api/v1/admin/billing/npi-verifications";
const VERIFY = `${LIST}/${PE}/verify`;
const REVOKE = `${LIST}/${PE}/revoke`;

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = MEMBERSHIP;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
  const kind = request.headers["x-test-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

const view: NpiVerificationView = {
  providerEntityId: PE,
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Synthetic Hospice Org",
  legalName: "Synthetic Hospice",
  npi: "1234567893",
  state: "verified",
  verificationId: "33333333-3333-4333-8333-333333333333",
  evidence: "NPPES record matches",
  verifiedAt: "2026-11-05T12:00:00.000Z",
  verifiedByMembershipId: MEMBERSHIP,
  revokedAt: null,
  revokedByMembershipId: null,
};

function makeServer() {
  const calls: { op: string; actor?: M23WriteActor; id?: string; body?: unknown }[] = [];
  const service: NpiVerificationService = {
    list: async () => [view],
    verify: async (actor, id, body) => {
      calls.push({ op: "verify", actor, id, body });
      return view;
    },
    revoke: async (actor, id) => {
      calls.push({ op: "revoke", actor, id });
      return { ...view, state: "revoked" };
    },
  };
  const grants = (userId: string, permissionKeys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("platform_1", [KEY]),
      grants("tenant_1", [KEY]),
      grants("none_1", []),
    ]).store,
  );
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM35AbacPredicates()))
    reg.register(name, predicate);
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerNpiVerificationRoutes(app, { npiVerificationService: service });
  return { app, calls };
}

const PLATFORM = { "x-test-user": "platform_1", "x-test-roles": "platform_admin" };
// A new Idempotency-Key per request: the host replays (or 409s) a reused one.
const fresh = () => ({ ...PLATFORM, "x-test-step-up": "1", "idempotency-key": randomUUID() });
const BODY = { npi: "1234567893", evidence: "NPPES record matches" };

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

describe("platform NPI verification routes", () => {
  it("lists for a platform operator holding the key", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: LIST, headers: PLATFORM });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([view]);
    await app.close();
  });

  it("refuses a tenant role that carries the key, and a caller without it", async () => {
    const { app } = makeServer();
    for (const headers of [
      { "x-test-user": "tenant_1", "x-test-roles": "org_admin" },
      { "x-test-user": "none_1", "x-test-roles": "platform_admin" },
    ]) {
      expect((await app.inject({ method: "GET", url: LIST, headers })).statusCode).toBe(403);
      const write = await app.inject({
        method: "POST",
        url: VERIFY,
        headers: { ...headers, "x-test-step-up": "1", "idempotency-key": randomUUID() },
        payload: BODY,
      });
      expect(write.statusCode).toBe(403);
    }
    await app.close();
  });

  it("verifies as the session's membership with the checked NPI and evidence", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({ method: "POST", url: VERIFY, headers: fresh(), payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([expect.objectContaining({ op: "verify", id: PE, body: BODY })]);
    expect(calls[0]?.actor?.membershipId).toBe(MEMBERSHIP);
    const revoke = await app.inject({ method: "POST", url: REVOKE, headers: fresh() });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().state).toBe("revoked");
    await app.close();
  });

  it("refuses a write without a fresh step-up, an Idempotency-Key, from an AI actor, or with a bad body", async () => {
    const { app, calls } = makeServer();
    const { "x-test-step-up": _s, ...stale } = fresh();
    const { "idempotency-key": _k, ...noKey } = fresh();
    const cases = [
      { headers: stale, payload: BODY },
      { headers: noKey, payload: BODY },
      { headers: { ...fresh(), "x-test-actor-kind": "ai_agent" }, payload: BODY },
      { headers: fresh(), payload: { npi: "123", evidence: "NPPES record matches" } },
      { headers: fresh(), payload: { npi: "1234567893", evidence: "" } },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: "POST", url: VERIFY, ...c });
      expect(res.statusCode, JSON.stringify(c.headers)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    const badId = await app.inject({
      method: "POST",
      url: `${LIST}/not-a-uuid/revoke`,
      headers: fresh(),
    });
    expect(badId.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("422s whitespace-only evidence (it would trim to '' and hit the DB CHECK as a 500)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: VERIFY,
      headers: fresh(),
      payload: { npi: "1234567893", evidence: "     " },
    });
    expect(res.statusCode).toBe(422);
    expect(calls).toEqual([]);
    await app.close();
  });
});
