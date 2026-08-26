// apps/backend/__tests__/encounter-routes.test.ts — M8-T09 route-inventory + §4.5 RBAC gating + §4.6
// `cosigner_role_match` ABAC + §7.7 optimistic-concurrency smoke tests (M8 spec §4.1, §4.2, §4.5, §4.6).
//
// Exercises M8's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerEncounterRoutes() mounts the §4.1 inventory over the in-memory
// encounter backend. The REAL Authorization Contract gates every route on the §4.5 keys; a header-auth
// shim populates request.context. The §4.6 predicate M8 owns is registered into the shared ABAC registry
// over the slice's resolver. Covers: RBAC gating (2xx with key, 403 without), cross-tenant 404, the
// finalize→sign happy path, the §7.7 If-Match version race (412 VERSION_MISMATCH), and the cosigner
// predicate (RN ∧ not-self-author).
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
} from "@wardenx/auth";
import { STEP_UP_POLICY } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, getSeam, registerSeam } from "../src/bootstrap/seams/registry";
import { buildEncounterAbacPredicates } from "../src/modules/08-encounters/index";
import {
  createInMemoryEncounterBackend,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";

/**
 * GAP-014: a FRESH `createPredicateRegistry()` per server/test — reusing the shared module-level
 * `abacRegistry` singleton (the old `resetAbacRegistry(); registerAbacRegistry(); registerEncounterAbacPredicates(...)`
 * pattern) would silently pin every test after the first to whatever backend the FIRST test's
 * registration closed over (`registerPredicateIdempotent`'s same-source-string reboot check can't
 * tell two DIFFERENT in-memory backends apart — see the GAP-011 memory note). Since this file's
 * sign/cosign-sign routes also gate on M3's `step_up_recent` (normally registered by
 * `registerAuthorizationAbacPredicates()` into that SAME shared singleton, which a fresh registry
 * bypasses), the fresh registry's seed reimplements `step_up_recent` inline over the same
 * `SessionContextResolver` seam + `isStepUpRecent` decision the real M3 predicate uses — not a
 * second, divergent copy of the DECISION, just a second registration site for the same pure check.
 */
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
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  // The sign/cosign-sign routes' requireStepUp(...) gate + signingActorOf() both read these — reusing
  // the test user id as both the membership id and the M2 session id keeps it consistent with the
  // in-memory backend's `authoredByUserId` seed data (self-cosign checks key off the same identifier).
  request.context.attributes.membershipId = user;
  request.context.attributes.sessionId = user;
}

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
// pre-seeded cosign_pending encounters (uuid-shaped slice ids).
const ENC_BY_LPN = "a0000000-0000-4000-8000-000000000001";
const ENC_BY_RN = "a0000000-0000-4000-8000-000000000002";
const ENC_B = "b0000000-0000-4000-8000-000000000003";

const ALL_AUTHOR = [
  "encounter.read",
  "encounter.author",
  "encounter.finalize",
  "encounter.sign",
  "encounter.cosign",
  "vitals.author",
  "mileage.author",
];

const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ALL_AUTHOR },
  { userId: "lpn_cos", permissions: ["encounter.read", "encounter.cosign"] },
  { userId: "viewer_1", permissions: ["encounter.read"] },
];

function makeServer(
  options: {
    isInCaseload?: (q: {
      organizationId: string;
      userId: string;
      patientId: string;
    }) => Promise<boolean>;
  } = {},
) {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      {
        id: ENC_BY_LPN,
        organizationId: ORG,
        patientId: PATIENT,
        discipline: "lpn",
        status: "cosign_pending",
        authoredByUserId: "lpn_1",
        cosignature: "routed",
      },
      {
        id: ENC_BY_RN,
        organizationId: ORG,
        patientId: PATIENT,
        discipline: "lpn",
        status: "cosign_pending",
        authoredByUserId: "rn_1",
        cosignature: "routed",
      },
      {
        id: ENC_B,
        organizationId: ORG_B,
        patientId: PATIENT,
        status: "draft",
        authoredByUserId: "rn_1",
      },
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.flatMap((s) =>
      [ORG, ORG_B].map((org) => ({
        orgId: org,
        userId: s.userId,
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions },
        ],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  resetAbacRegistry();
  const registry = createPredicateRegistry({
    ...M3_INTRINSIC_PREDICATES,
    step_up_recent: stepUpRecentPredicate,
  });
  const predicates = buildEncounterAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: options.isInCaseload ?? (async () => true),
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  // Every seeded actor starts with a FRESH step-up (real M3 step_up_recent decision, real M2 seam) —
  // the sign/cosign-sign routes' requireStepUp(...) gate needs this to reach the route handler at
  // all. `put` lets an individual test push a STALE session for one actor to exercise the deny path
  // for real.
  __resetSeamsForTest();
  const sessions = createInMemorySessionContextStore(
    PERMISSION_SEED.map((s) => ({
      sessionId: s.userId,
      userId: s.userId,
      membershipId: s.userId,
      organizationId: ORG,
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: new Date(),
      lastStepUpFactor: "webauthn" as const,
    })),
  );
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, { service: backend.service });
  return { app, backend, sessions };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const LPN_COSIGNER = { "x-test-user": "lpn_cos", "x-test-org": ORG, "x-test-roles": "lpn" };

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

describe("M8-T09 — encounter routes (§4.1, §4.5 RBAC gating)", () => {
  it("POST /encounters creates a draft for an authorized author (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("draft");
    expect(res.json().id).toMatch(/^e0000000-/);
  });

  it("422 on an illegal (encounter_type × discipline) pair at draft creation (§2.7)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "face_to_face", // md|np only
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INVALID_ENCOUNTER_DISCIPLINE_PAIR");
  });

  it("403 when the caller lacks encounter.author", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: VIEWER,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET reads are visible to a read-only viewer (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC_BY_LPN}`,
      headers: VIEWER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(ENC_BY_LPN);
  });

  it("a cross-tenant encounter is a non-leaking 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC_B}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
  });

  it("GAP-014: a clinician outside the patient's caseload is denied (404) reading the encounter", async () => {
    const { app } = makeServer({ isInCaseload: async () => false });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC_BY_LPN}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
  });

  it("GAP-014: a clinician outside the patient's caseload is denied (404) creating an encounter", async () => {
    const { app } = makeServer({ isInCaseload: async () => false });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GAP-014: caseload membership restores access (200) for the same clinician", async () => {
    const { app } = makeServer({ isInCaseload: async () => true });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${ENC_BY_LPN}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("M8-T09 — finalize → sign happy path (§2.3)", () => {
  it("an RN routine_visit draft finalizes then signs", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    const id = draft.json().id as string;

    const finalize = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN,
      payload: {},
    });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json().status).toBe("finalized");

    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(200);
    expect(sign.json().status).toBe("signed");
  });

  it("403 (requireStepUp) when the caller's session step-up is stale", async () => {
    const { app, sessions } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    const id = draft.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN,
      payload: {},
    });
    // Push rn_1's session past the 300s step-up floor (PARAM-004/CoP-418.104(c) follow-up — freshness
    // is now a real server-side check via requireStepUp, not a client-supplied timestamp; a stale
    // step-up denies at the ABAC gate (403) rather than reaching the old service-layer 412 domain check.
    sessions.put({
      sessionId: "rn_1",
      userId: "rn_1",
      membershipId: "rn_1",
      organizationId: ORG,
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: new Date(Date.now() - 10 * 60 * 1000),
      lastStepUpFactor: "webauthn",
    });

    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(403);
  });
});

describe("M8-T09 — §7.7 optimistic concurrency on selections PATCH", () => {
  it("428 without If-Match; 412 VERSION_MISMATCH on a stale version", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    const id = draft.json().id as string;

    const noMatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
      payload: { selections: {} },
    });
    expect(noMatch.statusCode).toBe(428);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { selections: {} },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { selections: {} },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe("VERSION_MISMATCH");
  });
});

describe("M8-T09 — §4.6 cosigner_role_match ABAC predicate", () => {
  it("a non-RN cosigner is refused (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC_BY_LPN}/cosignature/acknowledge`,
      headers: LPN_COSIGNER,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("an RN cannot cosign their own encounter (no self-cosign, 403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC_BY_RN}/cosignature/acknowledge`,
      headers: RN,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("an RN who is not the author may acknowledge (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${ENC_BY_LPN}/cosignature/acknowledge`,
      headers: RN,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("acknowledged");
  });
});
