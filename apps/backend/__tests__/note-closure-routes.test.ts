// ADR-0113 — the visit-note closure routes through the FULL M1 middleware chain (Fastify `inject`), no live infra: the REAL
// Authorization Contract gates every route on the two new keys + encounter.author, step-up is the real M3 decision over the
// session seam, and the services are faked. Also proves the four static `/api/v1/encounters/<segment>` paths are NOT swallowed by
// the existing `/api/v1/encounters/:encounterId` routes (same prefix, registered in the same app).
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
import { STEP_UP_POLICY } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import type { ClosureRouteService } from "../src/modules/08-encounters/closure/closure-route-service";
import {
  buildEncounterAbacPredicates,
  createInMemoryEncounterBackend,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { registerClosureRoutes } from "../src/modules/08-encounters/routes/closure-routes";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER = "a0000000-0000-4000-8000-000000000001";
const SUBJECT = "22222222-2222-4222-8222-222222222222";
const OVERRIDE_ID = "33333333-3333-4333-8333-333333333333";
const SITE = "44444444-4444-4444-8444-444444444444";
const GOOD_REASON = "Clinician is mid-admission visit and cannot finish the note right now.";
const NOW = "2026-11-17T12:00:00.000Z";

const STATUS = {
  mode: "block",
  thresholdHours: 24,
  verdict: "blocked",
  stage: "overdue",
  encounterId: ENCOUNTER,
  deadlineAt: NOW,
  hoursOverdue: 2,
  overdueCount: 1,
  overrideExpiresAt: null,
};
const BOARD = { mode: "block", thresholdHours: 24, items: [], truncated: false };
const OVERRIDE = {
  id: OVERRIDE_ID,
  subjectMembershipId: SUBJECT,
  grantedByMembershipId: "sup_1",
  obligationKind: "visit_note",
  grantedAt: NOW,
  expiresAt: NOW,
  revokedAt: null,
};
const POLICY = {
  obligationKind: "visit_note",
  mode: "warn",
  thresholdHours: 24,
  enforceFrom: null,
};

const PERMISSION_SEED = [
  { userId: "author_1", permissions: ["encounter.read", "encounter.author"] },
  { userId: "sup_1", permissions: ["encounter.read", "encounter.closure_override"] },
  {
    userId: "don_1",
    permissions: ["encounter.closure_override", "encounter.closure_policy_admin"],
  },
  { userId: "admin_1", permissions: ["encounter.closure_policy_admin"] },
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
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
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

function fakeService(): { [K in keyof ClosureRouteService]: ReturnType<typeof vi.fn> } {
  return {
    closureStatus: vi.fn(async () => STATUS),
    overdueNotes: vi.fn(async () => BOARD),
    grantOverride: vi.fn(async () => OVERRIDE),
    revokeOverride: vi.fn(async () => ({
      ...OVERRIDE,
      revokedAt: NOW,
      remainingActiveUntil: null,
    })),
    getPolicy: vi.fn(async () => POLICY),
    putPolicy: vi.fn(async (_actor: unknown, body: object) => ({
      ...POLICY,
      ...body,
      enforceFrom: null,
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
  registerClosureRoutes(app, { service: service as unknown as ClosureRouteService });
  return { app, service, sessions };
}

const as = (user: string, roles: string, extra: Record<string, string> = {}) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
  ...extra,
});
const KEYED = { "idempotency-key": "closure-grant-key-1" };
const AUTHOR = as("author_1", "rn");
const SUPERVISOR = as("sup_1", "clinical_supervisor", { "x-test-locations": SITE });
const DON = as("don_1", "director_of_nursing");
const ADMIN = as("admin_1", "org_admin");
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

describe("static closure paths are not swallowed by /api/v1/encounters/:encounterId", () => {
  it("GET closure-status reaches the closure service, not the encounter read", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/closure-status",
      headers: AUTHOR,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATUS);
    expect(service.closureStatus).toHaveBeenCalledTimes(1);
  });

  it("GET overdue-notes and GET closure-policy reach the closure service", async () => {
    const { app, service } = makeServer();
    const board = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/overdue-notes",
      headers: SUPERVISOR,
    });
    const policy = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/closure-policy",
      headers: DON,
    });
    expect([board.statusCode, policy.statusCode]).toEqual([200, 200]);
    expect(service.overdueNotes).toHaveBeenCalledTimes(1);
    expect(service.getPolicy).toHaveBeenCalledTimes(1);
  });

  it("PUT closure-policy and POST closure-overrides reach the closure service", async () => {
    const { app, service } = makeServer();
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/closure-policy",
      headers: ADMIN,
      payload: { mode: "block", thresholdHours: 24 },
    });
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: { ...SUPERVISOR, ...KEYED },
      payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
    });
    expect([put.statusCode, grant.statusCode]).toEqual([200, 201]);
    expect(service.putPolicy).toHaveBeenCalledTimes(1);
    expect(service.grantOverride).toHaveBeenCalledTimes(1);
  });

  it("the encounter read by id still resolves, and a real encounter id is not mistaken for a closure path", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENCOUNTER}`,
      headers: AUTHOR,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id ?? res.json().encounterId).toBe(ENCOUNTER);
    expect(service.closureStatus).not.toHaveBeenCalled();
  });
});

describe("permission gating", () => {
  const CASES: ReadonlyArray<[string, string, string, object | undefined]> = [
    ["GET", "/api/v1/encounters/closure-status", "encounter.author", undefined],
    ["GET", "/api/v1/encounters/overdue-notes", "encounter.closure_override", undefined],
    [
      "POST",
      "/api/v1/encounters/closure-overrides",
      "encounter.closure_override",
      { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
    ],
    [
      "POST",
      `/api/v1/encounters/closure-overrides/${OVERRIDE_ID}/revoke`,
      "encounter.closure_override",
      {},
    ],
    ["GET", "/api/v1/encounters/closure-policy", "encounter.closure_policy_admin", undefined],
    [
      "PUT",
      "/api/v1/encounters/closure-policy",
      "encounter.closure_policy_admin",
      { mode: "warn", thresholdHours: 24 },
    ],
  ];

  it.each(CASES)(
    "%s %s needs %s: a read-only caller is refused 403",
    async (method, url, _key, payload) => {
      const { app, service } = makeServer();
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: { ...VIEWER, ...KEYED },
        payload,
      });
      expect(res.statusCode).toBe(403);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it("a supervisor with the override key alone cannot change the policy, and an admin cannot grant an override", async () => {
    const { app } = makeServer();
    const putAsSupervisor = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/closure-policy",
      headers: SUPERVISOR,
      payload: { mode: "block", thresholdHours: 24 },
    });
    const grantAsAdmin = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: ADMIN,
      payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
    });
    expect([putAsSupervisor.statusCode, grantAsAdmin.statusCode]).toEqual([403, 403]);
  });

  it("an AI principal cannot grant, revoke or change the policy even holding the keys", async () => {
    const { app, service } = makeServer();
    const ai = as("don_1", "director_of_nursing", { "x-test-actor-kind": "ai_agent" });
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: ai,
      payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/closure-policy",
      headers: ai,
      payload: { mode: "off", thresholdHours: 24 },
    });
    expect([grant.statusCode, put.statusCode]).toEqual([403, 403]);
    expect(service.grantOverride).not.toHaveBeenCalled();
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("a session with no membership is refused (the override is attributed to a membership)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: { ...as("sup_1", "clinical_supervisor", { "x-test-no-membership": "1" }), ...KEYED },
      payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("step-up on the override routes", () => {
  const STALE_AT = new Date(Date.now() - 10 * 60 * 1000);
  const ROUTES: ReadonlyArray<[string, object]> = [
    ["/api/v1/encounters/closure-overrides", { subjectMembershipId: SUBJECT, reason: GOOD_REASON }],
    [`/api/v1/encounters/closure-overrides/${OVERRIDE_ID}/revoke`, {}],
  ];

  it.each(ROUTES)(
    "%s: a stale step-up is refused with STEP_UP_REQUIRED and nothing is written",
    async (url, payload) => {
      const { app, sessions, service } = makeServer();
      sessions.put(session("sup_1", STALE_AT));
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...SUPERVISOR, ...KEYED },
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
      expect(service.grantOverride).not.toHaveBeenCalled();
      expect(service.revokeOverride).not.toHaveBeenCalled();
    },
  );

  it("PUT closure-policy: a stale step-up is refused with STEP_UP_REQUIRED and the policy is not written", async () => {
    const { app, sessions, service } = makeServer();
    sessions.put(session("don_1", STALE_AT));
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/closure-policy",
      headers: { ...as("don_1", "director_of_nursing"), ...KEYED },
      payload: { obligationKind: "visit_note", mode: "block", thresholdHours: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("a fresh step-up grants: 201 with the override, the actor and an audit context from the session", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: { ...SUPERVISOR, ...KEYED },
      payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON, hours: 6 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(OVERRIDE);
    const [actor, request] = service.grantOverride.mock.calls[0] as [
      Record<string, string>,
      Record<string, unknown>,
    ];
    expect(actor).toMatchObject({ organizationId: ORG, userId: "sup_1", membershipId: "sup_1" });
    expect(request).toMatchObject({ subjectMembershipId: SUBJECT, reason: GOOD_REASON, hours: 6 });
    // the grant reads the caller's location scope exactly as the board does (this supervisor carries one site)
    expect(request.locationIds).toEqual([SITE]);
    expect(request.audit).toMatchObject({
      organizationId: ORG,
      userId: "sup_1",
      actorKind: "user",
    });
  });

  it("a grant without an Idempotency-Key is refused before the service runs", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: SUPERVISOR,
      payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(service.grantOverride).not.toHaveBeenCalled();
  });

  it("an org-wide role's grant carries a null scope; a supervisor with no site carries an empty one", async () => {
    for (const [headers, expected] of [
      [DON, null],
      [as("sup_1", "clinical_supervisor"), []],
    ] as const) {
      const { app, service } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/encounters/closure-overrides",
        headers: { ...headers, ...KEYED },
        payload: { subjectMembershipId: SUBJECT, reason: GOOD_REASON },
      });
      expect(res.statusCode).toBe(201);
      expect(service.grantOverride.mock.calls[0]?.[1]).toMatchObject({ locationIds: expected });
    }
  });

  it("a fresh step-up revokes: 200 with the revoked override, remainingActiveUntil and an audit context", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/closure-overrides/${OVERRIDE_ID}/revoke`,
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revokedAt).toBe(NOW);
    expect(res.json().remainingActiveUntil).toBeNull();
    expect(service.revokeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: "sup_1" }),
      OVERRIDE_ID,
      expect.objectContaining({ organizationId: ORG, userId: "sup_1", actorKind: "user" }),
    );
  });

  it("a revoke that leaves another supervisor's grant in force says until when", async () => {
    const { app, service } = makeServer();
    const until = "2026-11-17T16:00:00.000Z";
    service.revokeOverride.mockResolvedValueOnce({
      ...OVERRIDE,
      revokedAt: NOW,
      remainingActiveUntil: until,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/closure-overrides/${OVERRIDE_ID}/revoke`,
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.json().remainingActiveUntil).toBe(until);
  });
});

describe("request validation (422 VALIDATION_FAILED, nothing reaches the service)", () => {
  it.each([
    ["a reason under 40 characters", { subjectMembershipId: SUBJECT, reason: "too short" }],
    ["hours above 24", { subjectMembershipId: SUBJECT, reason: GOOD_REASON, hours: 25 }],
    ["hours of zero", { subjectMembershipId: SUBJECT, reason: GOOD_REASON, hours: 0 }],
    ["a non-uuid subject", { subjectMembershipId: "not-a-uuid", reason: GOOD_REASON }],
    ["a missing subject", { reason: GOOD_REASON }],
  ])("POST closure-overrides refuses %s", async (_label, payload) => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides",
      headers: { ...SUPERVISOR, ...KEYED },
      payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(service.grantOverride).not.toHaveBeenCalled();
  });

  it("revoke refuses a non-uuid override id", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters/closure-overrides/not-a-uuid/revoke",
      headers: SUPERVISOR,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(service.revokeOverride).not.toHaveBeenCalled();
  });

  it.each([
    ["threshold 0", { mode: "warn", thresholdHours: 0 }],
    ["threshold 169", { mode: "warn", thresholdHours: 169 }],
    ["an unknown mode", { mode: "strict", thresholdHours: 24 }],
    ["a missing mode", { thresholdHours: 24 }],
  ])("PUT closure-policy refuses %s", async (_label, payload) => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/closure-policy",
      headers: ADMIN,
      payload,
    });
    expect(res.statusCode).toBe(422);
    expect(service.putPolicy).not.toHaveBeenCalled();
  });

  it("PUT closure-policy passes a valid body through with the actor", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/encounters/closure-policy",
      headers: ADMIN,
      payload: { mode: "block", thresholdHours: 36 },
    });
    expect(res.statusCode).toBe(200);
    expect(service.putPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, userId: "admin_1" }),
      { mode: "block", thresholdHours: 36 },
      expect.objectContaining({ organizationId: ORG, userId: "admin_1" }),
    );
  });
});

describe("overdue-notes board scope and limit", () => {
  it("an org-wide role (director of nursing) gets null (every site)", async () => {
    const { app, service } = makeServer();
    await app.inject({ method: "GET", url: "/api/v1/encounters/overdue-notes", headers: DON });
    expect(service.overdueNotes.mock.calls[0]?.[1]).toEqual({ limit: 50, locationIds: null });
  });

  it("a site-scoped supervisor gets exactly their locations", async () => {
    const { app, service } = makeServer();
    await app.inject({
      method: "GET",
      url: "/api/v1/encounters/overdue-notes?limit=10",
      headers: SUPERVISOR,
    });
    expect(service.overdueNotes.mock.calls[0]?.[1]).toEqual({ limit: 10, locationIds: [SITE] });
  });

  it("a supervisor whose session carries no site gets an empty scope, not org-wide", async () => {
    const { app, service } = makeServer();
    await app.inject({
      method: "GET",
      url: "/api/v1/encounters/overdue-notes",
      headers: as("sup_1", "clinical_supervisor"),
    });
    expect(service.overdueNotes.mock.calls[0]?.[1]).toEqual({ limit: 50, locationIds: [] });
  });

  it("refuses a limit above the cap", async () => {
    const { app, service } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/encounters/overdue-notes?limit=500",
      headers: SUPERVISOR,
    });
    expect(res.statusCode).toBe(422);
    expect(service.overdueNotes).not.toHaveBeenCalled();
  });
});
