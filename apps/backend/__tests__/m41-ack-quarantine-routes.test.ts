// M41 held-acknowledgment operator routes (#820) over the route stack and the REAL Authorization Contract. The handlers' SQL is proven by
// m41-commercial-submission.live.test.ts; here every guard must stop a request BEFORE the (absent) deps are touched:
//   permission (403), session (401), Idempotency-Key (400), FRESH step-up (403), AI actor (403), provider scope (404),
//   body validation (422 with the standard envelope), and abandon-foreign refused for a provider-scoped (not org-wide) actor.
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
import { registerCommercialAckQuarantineRoutes } from "../src/modules/41-billing-commercial/routes/ack-quarantine.routes";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const OTHER_PE = "22222222-2222-4222-8222-999999999999";
const ROW = "33333333-3333-4333-8333-333333333333";
const KEYS: Record<string, string[]> = {
  sender: ["commercial_billing.submit", "commercial_billing.read"],
  reader: ["commercial_billing.read"],
  nobody: [],
};
const BASE = "/api/v1/billing/commercial/ack-quarantine";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
  request.context.attributes.membershipId = "66666666-6666-4666-8666-666666666666";
  if (request.headers["x-fresh"] === "1") request.context.attributes.stepUpRecent = true;
  if (request.headers["x-ai"] === "1") request.context.attributes.actorKind = "ai_assistant";
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      Object.entries(KEYS).map(([userId, permissionKeys]) => ({
        orgId: ORG,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      })),
    ).store,
  );
  const registry = createPredicateRegistry();
  registry.register("step_up_recent", async (ctx) => ctx.attributes.stepUpRecent === true);
  registry.register(
    "commercial_billing_provider_scope",
    async (_ctx, target) => (target as { providerEntityId?: string }).providerEntityId === PE,
  );
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  // deps are absent on purpose: a request that passes every guard would throw on them, so a guard test can only see 4xx
  registerCommercialAckQuarantineRoutes(app, { ack: {} as never });
  return app;
}

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

let keySeq = 0;
const as = (user: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "idempotency-key": `ack-${++keySeq}`,
  ...extra,
});
const FRESH = { "x-fresh": "1" };
const code = (res: { json(): { error?: { code?: string } } }) => res.json().error?.code;

const MUTATIONS: readonly { name: string; url: string; body: unknown }[] = [
  { name: "replay", url: `${BASE}/replay`, body: { providerEntityId: PE } },
  { name: "resolve", url: `${BASE}/${ROW}/resolve`, body: { providerEntityId: PE } },
  { name: "abandon-foreign", url: `${BASE}/abandon-foreign`, body: {} },
];

describe.each(MUTATIONS)("POST ack-quarantine $name", ({ url, body }) => {
  it("is 401 without a session and 403 without commercial_billing.submit", async () => {
    const app = makeServer();
    expect((await app.inject({ method: "POST", url, payload: body as object })).statusCode).toBe(
      401,
    );
    for (const user of ["reader", "nobody"]) {
      const res = await app.inject({
        method: "POST",
        url,
        payload: body as object,
        headers: as(user, FRESH),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("needs a FRESH step-up", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url,
      payload: body as object,
      headers: as("sender"),
    });
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("STEP_UP_REQUIRED");
  });

  it("refuses an AI actor and a missing Idempotency-Key", async () => {
    const app = makeServer();
    const ai = await app.inject({
      method: "POST",
      url,
      payload: body as object,
      headers: as("sender", { ...FRESH, "x-ai": "1" }),
    });
    expect(ai.statusCode).toBe(403);
    const noKey = await app.inject({
      method: "POST",
      url,
      payload: body as object,
      headers: { "x-test-user": "sender", ...FRESH },
    });
    expect(noKey.statusCode).toBe(400);
    expect(code(noKey)).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("provider scope and body checks", () => {
  it("answers 404 for a provider entity outside the actor's scope (replay and resolve)", async () => {
    const app = makeServer();
    for (const url of [`${BASE}/replay`, `${BASE}/${ROW}/resolve`]) {
      const res = await app.inject({
        method: "POST",
        url,
        payload: { providerEntityId: OTHER_PE },
        headers: as("sender", FRESH),
      });
      expect(res.statusCode).toBe(404);
    }
    const list = await app.inject({
      method: "GET",
      url: `${BASE}?providerEntityId=${OTHER_PE}`,
      headers: as("sender"),
    });
    expect(list.statusCode).toBe(404);
  });

  it("rejects a body that carries extra fields (no org or actor on the wire) with 422", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: `${BASE}/replay`,
      payload: { providerEntityId: PE, organizationId: ORG },
      headers: as("sender", FRESH),
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses abandon-foreign to an actor that is not organization-wide (403) before touching anything", async () => {
    const res = await makeServer().inject({
      method: "POST",
      url: `${BASE}/abandon-foreign`,
      payload: {},
      headers: as("sender", FRESH),
    });
    expect(res.statusCode).toBe(403);
  });

  it("the list needs commercial_billing.read", async () => {
    const res = await makeServer().inject({
      method: "GET",
      url: `${BASE}?providerEntityId=${PE}`,
      headers: as("nobody"),
    });
    expect(res.statusCode).toBe(403);
  });
});
