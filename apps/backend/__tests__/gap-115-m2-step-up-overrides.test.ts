// GAP-115 — the tenant step-up override WRITE routes (M2 §4.1, W-M2-10): tighten-only validation, permission +
// org binding, a required fresh step-up on the writes, audit + outbox.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createFixedActorResolver,
  createInMemoryAuditExecutor,
} from "../src/modules/02-identity/index";
import { registerStepUpOverrideRoutes } from "../src/modules/02-identity/routes/step-up-override-routes";
import { createInMemoryStepUpOverrideAdminStore } from "../src/modules/02-identity/step-up-override-admin";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
}

const ADMIN = { "x-test-user": "admin_1", "x-test-org": "org_a" };
const NOBODY = { "x-test-user": "nobody", "x-test-org": "org_a" };
const OTHER_ORG_ADMIN = { "x-test-user": "admin_1", "x-test-org": "org_b" };

function makeServer(opts: { stepUpFresh?: boolean } = {}) {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      ...["org_a", "org_b"].map((orgId) => ({
        orgId,
        userId: "admin_1",
        grants: [
          {
            roleKey: "org_admin",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["step_up_override.manage"],
          },
        ],
      })),
    ]).store,
  );
  registerAbacRegistry(createPredicateRegistry({ step_up_recent: () => opts.stepUpFresh ?? true }));
  const overrides = createInMemoryStepUpOverrideAdminStore();
  const auditSink = createInMemoryAuditExecutor();
  const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerStepUpOverrideRoutes(app, {
    actors: createFixedActorResolver({
      userId: "admin_1",
      sessionId: "s1",
      organizationId: "org_a",
      membershipId: "m_admin",
      roles: ["org_admin"],
    }),
    audit: auditSink.executor,
    outbox: {
      async publish(e) {
        published.push({ eventName: e.eventName, payload: e.payload });
      },
    },
    overrides: overrides.store,
  });
  return { app, overrides, auditSink, published };
}

const URL = "/api/v1/orgs/org_a/step-up-overrides";
const VALID = {
  operationKey: "patient.merge",
  qualifyingFactors: ["webauthn"],
  maxAgeSec: 60,
  rationale: "SUD-adjacent merge needs a hardware key",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("GAP-115 — step-up override admin routes", () => {
  it("a valid tightening is stored, audited and published; GET lists it", async () => {
    const { app, overrides, auditSink, published } = makeServer();
    const res = await app.inject({ method: "POST", url: URL, headers: ADMIN, payload: VALID });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      operationKey: "patient.merge",
      qualifyingFactors: ["webauthn"],
      maxAgeSec: 60,
      configuredByMembershipId: "m_admin",
    });
    expect(overrides.all()).toHaveLength(1);
    expect(
      auditSink.rows.some((r) => r.eventType === "m2.session.step_up_policy_override.configured"),
    ).toBe(true);
    expect(published[0]?.eventName).toBe("m2.session.step_up_policy_override.configured");
    const list = await app.inject({ method: "GET", url: URL, headers: ADMIN });
    expect(list.json().overrides).toHaveLength(1);
    await app.close();
  });

  it.each([
    ["an SMS factor (loosening)", { qualifyingFactors: ["webauthn", "sms"] }],
    ["an empty factor set (a lockout)", { qualifyingFactors: [] }],
    ["a window longer than the floor", { maxAgeSec: 301 }],
    ["a non-positive window", { maxAgeSec: 0 }],
    ["a bad operation key", { operationKey: "Patient Merge" }],
    ["a missing rationale", { rationale: "short" }],
  ])("refuses %s with 422 and stores nothing", async (_label, patch) => {
    const { app, overrides } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: ADMIN,
      payload: { ...VALID, ...patch },
    });
    expect(res.statusCode).toBe(422);
    expect(overrides.all()).toHaveLength(0);
    await app.close();
  });

  it("the floor itself (300s, both factors) is accepted — equal is not looser", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: ADMIN,
      payload: { ...VALID, qualifyingFactors: ["webauthn", "totp"], maxAgeSec: 300 },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("DELETE removes the override; a second DELETE is 404", async () => {
    const { app } = makeServer();
    await app.inject({ method: "POST", url: URL, headers: ADMIN, payload: VALID });
    const first = await app.inject({
      method: "DELETE",
      url: `${URL}/patient.merge`,
      headers: ADMIN,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "DELETE",
      url: `${URL}/patient.merge`,
      headers: ADMIN,
    });
    expect(second.statusCode).toBe(404);
    await app.close();
  });

  it("requires step_up_override.manage (403) and the bound org (403)", async () => {
    const { app } = makeServer();
    expect((await app.inject({ method: "GET", url: URL, headers: NOBODY })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: URL, headers: OTHER_ORG_ADMIN, payload: VALID }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });

  it("the writes need a FRESH step-up; the read does not", async () => {
    const { app, overrides } = makeServer({ stepUpFresh: false });
    const post = await app.inject({ method: "POST", url: URL, headers: ADMIN, payload: VALID });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(overrides.all()).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: URL, headers: ADMIN })).statusCode).toBe(200);
    await app.close();
  });
});
