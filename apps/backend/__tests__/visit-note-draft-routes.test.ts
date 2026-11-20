// ADR-0114 VN-D17 - the visit-note draft switch routes through the FULL M1 middleware chain (Fastify `inject`), no live infra: the REAL
// Authorization Contract gates both routes on `encounter.draft_policy_admin`, step-up is the real M3 decision over the session seam, and
// the service is faked. Also proves the literal `/api/v1/encounters/draft-policy` path is NOT swallowed by
// `/api/v1/encounters/:encounterId` (same prefix, registered in the same app).
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  isStepUpRecent,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { ChartWardenError } from "@chartwarden/types";
import { STEP_UP_POLICY } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import type { DraftRouteService } from "../src/modules/08-encounters/drafting/route-service";
import {
  buildEncounterAbacPredicates,
  createInMemoryEncounterBackend,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { registerDraftingRoutes } from "../src/modules/08-encounters/routes/drafting-routes";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER = "a0000000-0000-4000-8000-000000000001";
const POLICY = { enabled: false, reviewStatus: "pending", reviewer: "ADA" };

const PERMISSION_SEED = [
  { userId: "author_1", permissions: ["encounter.read", "encounter.author"] },
  {
    userId: "don_1",
    permissions: ["encounter.closure_policy_admin", "encounter.draft_policy_admin"],
  },
  { userId: "admin_1", permissions: ["encounter.draft_policy_admin"] },
  // The closure policy key alone must NOT open the draft switch (two keys, one owner set, never conflated).
  { userId: "closure_1", permissions: ["encounter.closure_policy_admin"] },
  { userId: "viewer_1", permissions: ["encounter.read"] },
];

function stepUpRecentPredicate(context: {
  organizationId: string;
  attributes: Record<string, unknown>;
}) {
  const sessionId =
    typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null;
  if (!sessionId || !context.organizationId) return Promise.resolve(false);
  return getSeam("SessionContextResolver")
    .resolveStepUpState({ orgId: context.organizationId }, sessionId)
    .then((state) => isStepUpRecent(state, STEP_UP_POLICY, Date.now()));
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
  const kind = request.headers["x-test-actor-kind"];
  request.context.attributes.actorKind = typeof kind === "string" ? kind : "user";
  if (request.headers["x-test-no-membership"] === "1")
    request.context.attributes.membershipId = undefined;
}

const session = (userId: string, lastStepUpAt: Date) => ({
  sessionId: userId,
  userId,
  membershipId: userId,
  organizationId: ORG,
  roles: [],
  providerEntityIds: [],
  locationIds: [],
  lastStepUpAt,
  lastStepUpFactor: "webauthn" as const,
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
});

function fakeService(): { [K in keyof DraftRouteService]: ReturnType<typeof vi.fn> } {
  return {
    getPolicy: vi.fn(async () => POLICY),
    putPolicy: vi.fn(async (_actor: unknown, body: { enabled: boolean }) => ({
      ...POLICY,
      enabled: body.enabled,
    })),
  };
}

function makeServer() {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENCOUNTER,
        organizationId: ORG,
        patientId: PATIENT,
        discipline: "rn",
        status: "draft",
        authoredByUserId: "author_1",
      },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore(
      PERMISSION_SEED.map((s) => ({
        orgId: ORG,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ).store,
  );
  resetAbacRegistry();
  const registry = createPredicateRegistry({
    ...M3_INTRINSIC_PREDICATES,
    step_up_recent: stepUpRecentPredicate,
  });
  const predicates = buildEncounterAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  __resetSeamsForTest();
  const sessions = createInMemorySessionContextStore(
    PERMISSION_SEED.map((s) => session(s.userId, new Date())),
  );
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));

  const service = fakeService();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, {
    service: backend.service,
    caseloadPatientIds: async () => [PATIENT],
  });
  registerDraftingRoutes(app, { service: service as unknown as DraftRouteService });
  return { app, service, sessions };
}

const as = (user: string, roles: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
  ...extra,
});
const DON = as("don_1", "director_of_nursing");
const ADMIN = as("admin_1", "org_admin");
const CLOSURE_ONLY = as("closure_1", "director_of_nursing");
const AUTHOR = as("author_1", "rn");
const VIEWER = as("viewer_1", "auditor");

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

describe("the static draft-policy path is not swallowed by /api/v1/encounters/:encounterId", () => {
  it("GET reaches the drafting service and answers enabled, reviewStatus and reviewer", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/draft-policy",
      headers: DON,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(POLICY);
    expect(service.getPolicy).toHaveBeenCalledWith(ORG);
  });

  it("PUT reaches the drafting service", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: ADMIN,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...POLICY, enabled: true });
    expect(service.putPolicy).toHaveBeenCalledTimes(1);
  });

  it("the encounter read by id still resolves", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENCOUNTER}`,
      headers: AUTHOR,
    });
    expect(res.statusCode).toBe(200);
    expect(service.getPolicy).not.toHaveBeenCalled();
  });
});

describe("permission gating", () => {
  it.each([
    ["GET", undefined],
    ["PUT", { enabled: true }],
  ])(
    "%s needs encounter.draft_policy_admin: a read-only caller is refused 403",
    async (method, payload) => {
      const { app, service } = makeServer();
      const res = await app.inject({
        method: method as "GET",
        url: "/api/v1/encounters/draft-policy",
        headers: VIEWER,
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(service.getPolicy).not.toHaveBeenCalled();
      expect(service.putPolicy).not.toHaveBeenCalled();
    },
  );

  it("the closure policy key alone does not open the draft switch", async () => {
    const { app, service } = makeServer();
    const get = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/draft-policy",
      headers: CLOSURE_ONLY,
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: CLOSURE_ONLY,
      payload: { enabled: false },
    });
    expect([get.statusCode, put.statusCode]).toEqual([403, 403]);
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("an AI principal cannot change the switch even holding the key", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: as("don_1", "director_of_nursing", { "x-test-actor-kind": "ai_agent" }),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("a session with no membership is refused (the switch is attributed to a membership)", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: as("admin_1", "org_admin", { "x-test-no-membership": "1" }),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(service.putPolicy).not.toHaveBeenCalled();
  });
});

describe("step-up on the PUT", () => {
  it("a stale step-up is refused with STEP_UP_REQUIRED and the switch is not written", async () => {
    const { app, sessions, service } = makeServer();
    sessions.put(session("don_1", new Date(Date.now() - 10 * 60 * 1000)));
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: DON,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("a fresh step-up passes the body, the actor and an audit context from the session to the service", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: ADMIN,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(service.putPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, userId: "admin_1", membershipId: "admin_1" }),
      { enabled: true },
      expect.objectContaining({ organizationId: ORG, userId: "admin_1", actorKind: "user" }),
    );
  });

  it("the GET needs no step-up (a stale session still reads the switch)", async () => {
    const { app, sessions } = makeServer();
    sessions.put(session("don_1", new Date(Date.now() - 10 * 60 * 1000)));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/draft-policy",
      headers: DON,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("body validation and typed errors", () => {
  it.each([
    ["a missing enabled", {}],
    ["a string enabled", { enabled: "yes" }],
    ["a null enabled", { enabled: null }],
  ])("PUT refuses %s with 422 and writes nothing", async (_label, payload) => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: ADMIN,
      payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("a CORPUS_REVIEW_PENDING refusal from the service reaches the client as a 409 with the standard envelope", async () => {
    const { app, service } = makeServer();
    service.putPolicy.mockRejectedValueOnce(
      new ChartWardenError("CORPUS_REVIEW_PENDING", "review pending", 409),
    );
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/draft-policy",
      headers: ADMIN,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CORPUS_REVIEW_PENDING");
  });
});
