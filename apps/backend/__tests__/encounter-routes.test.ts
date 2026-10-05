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
import { requiredSectionSelections } from "./_hearthnote-fixtures";

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
// F-064 — M7 care-plan element refs (logical uuids; the table carries no cross-module FK).
const PROBLEM = "44444444-4444-4444-8444-444444444444";
const GOAL = "55555555-5555-4555-8555-555555555555";
const INTERVENTION = "66666666-6666-4666-8666-666666666666";
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
  "encounter.addendum_author",
  "vitals.author",
  "mileage.author",
];

const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ALL_AUTHOR },
  { userId: "rn_2", permissions: ALL_AUTHOR },
  { userId: "sup_1", permissions: ALL_AUTHOR },
  { userId: "lpn_cos", permissions: ["encounter.read", "encounter.cosign"] },
  { userId: "viewer_1", permissions: ["encounter.read"] },
  { userId: "svc_m22", permissions: ["encounter.read_internal"] },
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
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
    })),
  );
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, { service: backend.service });
  return { app, backend, sessions };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const RN2 = { "x-test-user": "rn_2", "x-test-org": ORG, "x-test-roles": "rn" };
const SUPERVISOR = {
  "x-test-user": "sup_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_supervisor",
};
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const LPN_COSIGNER = { "x-test-user": "lpn_cos", "x-test-org": ORG, "x-test-roles": "lpn" };
/** The system principal the M22 render seam (route 31) is called as. */
const INTERNAL = { "x-test-user": "svc_m22", "x-test-org": ORG, "x-test-roles": "system" };

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

    // The §2.6 Layer-3 gate (#121) refuses a note with nothing in it, so the happy path documents one
    // first — which is what this test always claimed to be exercising. Before the gate was real it
    // finalized and signed an encounter carrying zero selections, and passed.
    const documented = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: requiredSectionSelections("routine_visit", "rn"),
    });
    expect(documented.statusCode).toBe(200);

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
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: requiredSectionSelections("routine_visit", "rn"),
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN,
      payload: {},
    });
    // Asserted so the 403 below can only be the step-up gate: an undocumented draft never reaches
    // `finalized`, and a sign attempt on a still-`draft` row would 403 at the preHandler for a
    // different reason entirely.
    expect(finalized.statusCode).toBe(200);
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
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
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

    // `{ sections: [] }` is the empty tree. It used to be `{ selections: {} }` against a schema that
    // validated nothing and a handler that read nothing (#114).
    const noMatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
      payload: { sections: [] },
    });
    expect(noMatch.statusCode).toBe(428);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { sections: [] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { sections: [] },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe("VERSION_MISMATCH");
  });
});

// #114 — the two selections PATCHes published a required body, parsed none of it, bumped the version and
// returned 200. The clinician's note was accepted and dropped; nothing had ever written a
// `hearthnote_selection` row, and no read existed through which the loss could be seen.
describe("M8 §2.6 — the HearthNote selection tree round-trips (#114)", () => {
  const TREE = {
    sections: [
      {
        sectionId: "assessment",
        entries: [{ code: "nv.cv.stable" }, { code: "nv.cv.edema", params: { edema_grade: "2+" } }],
      },
      { sectionId: "plan", entries: [], freeText: "Family to call if pain escalates overnight." },
    ],
  };

  async function draft(app: Awaited<ReturnType<typeof makeServer>>["app"]): Promise<string> {
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
    return res.json().id as string;
  }

  it("writes the tree and reads it back through a caller-facing route", async () => {
    const { app } = makeServer();
    const id = await draft(app);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: TREE,
    });
    expect(patched.statusCode).toBe(200);
    // The response is the assembled note, not an empty string — the entry's `${edema_grade}` param and
    // the verbatim free text are both in it.
    expect(patched.json().layer1Preview).toContain("cardiovascularly stable");
    expect(patched.json().layer1Preview).toContain("2+ dependent edema");
    expect(patched.json().layer1Preview).toContain("Family to call if pain escalates overnight.");

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().templateKey).toBe("routine_visit:rn");
    expect(read.json().sections).toEqual(TREE.sections);
    expect(read.json().layer1Preview).toBe(patched.json().layer1Preview);
  });

  it("the template route serves the MENU the tree is built from — sections AND their vocabulary (F-063)", async () => {
    // The composer's blocker, and the reason the authoring surface did not exist: `PATCH .../selections`
    // carries `sectionId`/`code` as free strings and rejects an unknown one (the two cases below), so a
    // client needs to know which sections this encounter's template has and which codes each accepts.
    // `resolveTemplate` + `entriesFor` had existed since M8-T05 and were on nobody's wire.
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/template`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().templateKey).toBe("routine_visit:rn");
    const sections = res.json().sections as {
      sectionId: string;
      required: boolean;
      entries: { code: string; slots: string[] }[];
    }[];
    // The menu must agree with what the write path accepts, in BOTH directions — that is the whole
    // point of serving it rather than shipping the corpus to the browser.
    expect(sections.map((x) => x.sectionId)).toContain("assessment");
    const assessment = sections.find((x) => x.sectionId === "assessment");
    expect(assessment?.required).toBe(true);
    const codes = assessment?.entries.map((e) => e.code) ?? [];
    expect(codes).toContain("nv.cv.stable");
    expect(codes).toContain("nv.cv.edema");
    // `slots` is what the client must send as `params`: the phrase's placeholders minus the two the
    // assembly context fills. `nv.cv.edema` interpolates `${edema_grade}`, which the round-trip above
    // sends and the assembled narrative renders as "2+ dependent edema".
    expect(assessment?.entries.find((e) => e.code === "nv.cv.edema")?.slots).toEqual([
      "edema_grade",
    ]);
    expect(assessment?.entries.find((e) => e.code === "nv.cv.stable")?.slots).toEqual([]);
  });

  // ── F-064 (#159) — care-plan links ────────────────────────────────────────────────────────────────
  //
  // These three routes had NO test of any kind. `POST .../care-plan-links` parsed a body carrying the M7
  // problem/goal/intervention refs, passed NONE of them on — `addCarePlanLink(organizationId,
  // encounterId)` took no third argument — persisted nothing, and answered 201 Created with the
  // ENCOUNTER's own id under the name `linkId`. `DELETE` returned 204 having removed nothing. There was
  // no `GET`. Every assertion below fails against that implementation.
  it("persists the M7 refs the body carries, and returns the LINK's id", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
      payload: { problemId: PROBLEM, interventionId: INTERVENTION },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // The old response's `linkId` WAS the encounter id. A caller that stored it held an encounter id
    // under a link-shaped name, and nothing distinguished that from a working create.
    expect(body.id).not.toBe(id);
    expect(body.encounterId).toBe(id);
    expect(body.problemId).toBe(PROBLEM);
    expect(body.interventionId).toBe(INTERVENTION);
    expect(body.goalId).toBeNull();
    await app.close();
  });

  it("reads the links back — the table would be write-only without the GET", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
    });
    expect(before.json().links).toEqual([]);
    await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
      payload: { goalId: GOAL },
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
    });
    expect(after.json().links).toHaveLength(1);
    expect(after.json().links[0].goalId).toBe(GOAL);
    await app.close();
  });

  it("refuses a link naming no element with a 422, not a raw CHECK violation", async () => {
    // `encounter_care_plan_link_at_least_one` is a DB CHECK, so an empty body would have surfaced as a
    // `23514` — a 500 carrying a Postgres constraint name.
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.code ?? res.json().code).toBe("CARE_PLAN_LINK_REF_REQUIRED");
    await app.close();
  });

  it("removal actually removes: the link stops being listed", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
      payload: { problemId: PROBLEM },
    });
    const linkId = created.json().id as string;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/encounters/${id}/care-plan-links/${linkId}`,
      headers: RN,
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
    });
    // The old DELETE returned 204 having removed nothing, which is indistinguishable from this.
    expect(after.json().links).toEqual([]);
    await app.close();
  });

  it("removing a link that is absent or already removed is a 404, not another 204", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/care-plan-links`,
      headers: RN,
      payload: { problemId: PROBLEM },
    });
    const linkId = created.json().id as string;
    await app.inject({
      method: "DELETE",
      url: `/api/v1/encounters/${id}/care-plan-links/${linkId}`,
      headers: RN,
    });
    const second = await app.inject({
      method: "DELETE",
      url: `/api/v1/encounters/${id}/care-plan-links/${linkId}`,
      headers: RN,
    });
    expect(second.statusCode).toBe(404);
    await app.close();
  });

  it("mileage reads back the row its writes create (F-063)", async () => {
    // `POST`/`PATCH .../mileage` wrote a real row and no route returned it — the write-only shape #92
    // fixed for vitals, on the table beside it.
    const { app } = makeServer();
    const id = await draft(app);
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/mileage`,
      headers: RN,
    });
    expect(before.statusCode).toBe(200);
    // null rather than 404: the encounter exists and has no mileage, which is an answer.
    expect(before.json()).toBeNull();

    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/mileage`,
      headers: RN,
      payload: {
        milesDriven: "12.4",
        source: "manual_override",
        manualOverrideReason: "the vehicle odometer was unreadable at the start of the visit",
      },
    });
    expect(posted.statusCode).toBe(201);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/mileage`,
      headers: RN,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().milesDriven).toBe("12.4");
    expect(after.json().source).toBe("manual_override");
  });

  it("a fresh draft reads back an EMPTY tree — absent is distinguishable from written", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().sections).toEqual([]);
    expect(read.json().layer1Preview).toBe("");
  });

  it("refuses a vocabulary code the corpus does not have — and stores nothing", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { sections: [{ sectionId: "assessment", entries: [{ code: "nv.not.a.code" }] }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("UNKNOWN_VOCAB_CODE");
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
    });
    expect(read.json().sections).toEqual([]);
  });

  // `assembleLayer1` walks the TEMPLATE's sections and looks each one up in the selection, so a section
  // the template does not have is never visited — it would be stored and then vanish from every render.
  it("refuses a section the template does not have, rather than storing content that never renders", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { sections: [{ sectionId: "not_a_section", entries: [{ code: "nv.cv.stable" }] }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("UNKNOWN_TEMPLATE_SECTION");
  });

  it("the M22 render seam serves the assembled note, and 404s when there is none to render", async () => {
    const { app } = makeServer();
    const id = await draft(app);

    // Was `{ final: "" }` with a 200 — a renderable answer for a note that does not exist.
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/internal/encounters/${id}/render-payload`,
      headers: INTERNAL,
    });
    expect(empty.statusCode).toBe(404);

    await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: TREE,
    });
    const rendered = await app.inject({
      method: "GET",
      url: `/api/v1/internal/encounters/${id}/render-payload`,
      headers: INTERNAL,
    });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.json().final).toContain("Assessment");
    expect(rendered.json().final).toContain("cardiovascularly stable");
    // A draft has nothing pinned, so this is a live re-assembly — and it says so on the wire (#122).
    expect(rendered.json().pinned).toBe(false);

    // Document the rest of the §2.6 required set so the gate lets this finalize (TREE deliberately
    // populates only two sections), then capture the preview the pin must match.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "1" },
      payload: requiredSectionSelections("routine_visit", "rn"),
    });
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/internal/encounters/${id}/render-payload`,
      headers: INTERNAL,
    });
    expect(preview.json().pinned).toBe(false);

    // Finalize pins it. Afterwards the same route serves the PINNED bytes, and a renderer can tell the
    // legal record from a preview of one without asking what status the encounter is in.
    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN,
      payload: { at: "2026-06-20" },
    });
    expect(finalized.statusCode).toBe(200);
    const pinned = await app.inject({
      method: "GET",
      url: `/api/v1/internal/encounters/${id}/render-payload`,
      headers: INTERNAL,
    });
    expect(pinned.json().pinned).toBe(true);
    expect(pinned.json().final).toBe(preview.json().final);
  });

  // ── §2.6 D5 Layer-2 (#123) ───────────────────────────────────────────────────────────────────────

  it("the Layer-2 enhance route answers the D5 ladder's reason, not a fabricated modification id", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/hearthnote/enhance`,
      headers: RN,
      payload: { style: { tone: "formal", brevity: "concise" } },
    });
    expect(res.statusCode).toBe(200);
    // Was `{ modificationId: <the ENCOUNTER's own id> }` — an identifier for something else entirely.
    expect(res.json()).toEqual({ enhanced: false, reason: "kill_switch_active" });
    expect(res.json().modificationId).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain(id);
  });

  it("a per-passage decision against a modification that does not exist is a 404, not an echo", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    // Was a 200 echoing back whatever id the caller invented. Nothing writes
    // `hearthnote_llm_modification`, so every id names nothing — and the route now says so.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/hearthnote/modifications/2f1d4c9e-0000-4000-8000-000000000001/decisions`,
      headers: RN,
      payload: { decision: "accept" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("an addendum keeps its own tree, against its parent's template", async () => {
    const { app } = makeServer();
    const id = await draft(app);
    // An addendum is only legal on a signed/cosigned parent (409 ILLEGAL_TRANSITION otherwise), so the
    // parent is documented, finalized and signed first.
    const documented = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: requiredSectionSelections("routine_visit", "rn"),
    });
    expect(documented.statusCode).toBe(200);
    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN,
      payload: {},
    });
    expect(finalized.statusCode).toBe(200);
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: RN,
      payload: { attestationConfirmed: true },
    });
    expect(signed.statusCode).toBe(200);
    const parentBefore = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
    });
    expect(parentBefore.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/addenda`,
      headers: RN,
      payload: { reason: "late clarification of the evening pain plan" },
    });
    expect(created.statusCode).toBe(201);
    const addendumId = created.json().id as string;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/addenda/${addendumId}/selections`,
      headers: { ...RN, "if-match": "0" },
      payload: { sections: [{ sectionId: "plan", entries: [], freeText: "Clarifying the plan." }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().layer1Preview).toContain("Clarifying the plan.");

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/addenda/${addendumId}/selections`,
      headers: RN,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().templateKey).toBe("routine_visit:rn");
    expect(read.json().layer1Preview).toContain("Clarifying the plan.");
    // The parent's own tree is untouched — the addendum is a separate row, not an overwrite.
    const parent = await app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}/selections`,
      headers: RN,
    });
    expect(parent.json().sections).toEqual(parentBefore.json().sections);
    expect(JSON.stringify(parent.json().sections)).not.toContain("Clarifying the plan.");
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

describe("GAP-028 — M8 author ABAC (is_author / is_author_or_supervisor / is_addendum_author)", () => {
  type Server = ReturnType<typeof makeServer>;
  const VITALS_BODY = { bpSystolic: 120, bpDiastolic: 80, heartRate: 70 };

  async function draftBy(app: Server["app"], headers: Record<string, string>): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers,
      payload: {
        patientId: PATIENT,
        admissionId: ADMISSION,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-06-20",
      },
    });
    return res.json().id as string;
  }

  async function finalizedBy(app: Server["app"], headers: Record<string, string>): Promise<string> {
    const id = await draftBy(app, headers);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...headers, "if-match": "0" },
      payload: requiredSectionSelections("routine_visit", "rn"),
    });
    const fin = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers,
      payload: {},
    });
    expect(fin.statusCode).toBe(200);
    return id;
  }

  const sign = (app: Server["app"], id: string, headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers,
      payload: { attestationConfirmed: true },
    });

  it("403 when another clinician (holding encounter.sign) signs someone else's note", async () => {
    const { app } = makeServer();
    const id = await finalizedBy(app, RN);
    const res = await sign(app, id, RN2);
    expect(res.statusCode).toBe(403);
    // the author can still sign it — the refusal changed nothing.
    expect((await sign(app, id, RN)).statusCode).toBe(200);
  });

  it("403 when another clinician finalizes someone else's note", async () => {
    const { app } = makeServer();
    const id = await draftBy(app, RN);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/finalize`,
      headers: RN2,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("vitals: a non-author is refused (403) but the author and a supervisor are allowed", async () => {
    const { app } = makeServer();
    const id = await draftBy(app, RN);
    const url = `/api/v1/encounters/${id}/vitals`;
    expect(
      (await app.inject({ method: "POST", url, headers: RN2, payload: VITALS_BODY })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url, headers: SUPERVISOR, payload: VITALS_BODY }))
        .statusCode,
    ).not.toBe(403);
    expect(
      (await app.inject({ method: "POST", url, headers: RN, payload: VITALS_BODY })).statusCode,
    ).not.toBe(403);
  });

  it("selections PATCH: a non-author is refused (403)", async () => {
    const { app } = makeServer();
    const id = await draftBy(app, RN);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/encounters/${id}/selections`,
      headers: { ...RN2, "if-match": "0" },
      payload: requiredSectionSelections("routine_visit", "rn"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("routes 4-7/9-14 read as 404 when the patient is outside the caller's caseload", async () => {
    const { app } = makeServer({
      isInCaseload: async (q) => q.userId === "rn_1",
    });
    const id = await draftBy(app, RN);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["POST", `/api/v1/encounters/${id}/vitals`, VITALS_BODY],
      [
        "POST",
        `/api/v1/encounters/${id}/mileage`,
        {
          odometerStart: 1,
          odometerEnd: 5,
          source: "manual_override",
          manualOverrideReason: "route offline",
        },
      ],
      ["POST", `/api/v1/encounters/${id}/evv-reconcile`, { evvMissingReason: "device offline" }],
      ["POST", `/api/v1/encounters/${id}/finalize`, {}],
      ["POST", `/api/v1/encounters/${id}/sign`, { attestationConfirmed: true }],
      ["POST", `/api/v1/encounters/${id}/hearthnote/enhance`, {}],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({ method: method as "POST", url, headers: RN2, payload });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("an addendum is attributed to the CALLER, not the parent's author", async () => {
    const { app, backend } = makeServer();
    const id = await finalizedBy(app, RN);
    expect((await sign(app, id, RN)).statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/addenda`,
      headers: RN2,
      payload: { reason: "late clarification of the evening pain plan" },
    });
    expect(created.statusCode).toBe(201);
    const addendumId = created.json().id as string;
    expect(await backend.resolver.loadAddendumAuthor(ORG, id, addendumId)).toBe("rn_2");

    // the addendum's author may edit it; the parent's author may not.
    const url = `/api/v1/encounters/${id}/addenda/${addendumId}/selections`;
    const payload = { sections: [{ sectionId: "plan", entries: [], freeText: "Clarify." }] };
    expect(
      (await app.inject({ method: "PATCH", url, headers: { ...RN, "if-match": "0" }, payload }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "PATCH", url, headers: { ...RN2, "if-match": "0" }, payload }))
        .statusCode,
    ).toBe(200);
    // finalize and sign are likewise addendum-author only.
    const base = `/api/v1/encounters/${id}/addenda/${addendumId}`;
    expect(
      (await app.inject({ method: "POST", url: `${base}/finalize`, headers: RN, payload: {} }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/sign`,
          headers: RN,
          payload: { attestationConfirmed: true },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("predicates fail closed on missing ids and unknown addenda", async () => {
    const { backend } = makeServer();
    const preds = buildEncounterAbacPredicates({
      resolver: backend.resolver,
      isInCaseload: async () => true,
    });
    const ctx = {
      organizationId: ORG,
      userId: "rn_1",
      roles: ["rn"],
      attributes: { membershipId: "rn_1" },
    } as never;
    expect(await preds.is_author?.(ctx, {})).toBe(false);
    expect(await preds.is_author_or_supervisor?.(ctx, {})).toBe(false);
    expect(await preds.is_addendum_author?.(ctx, { encounterId: ENC_B })).toBe(false);
    expect(
      await preds.is_addendum_author?.(ctx, { encounterId: ENC_BY_RN, addendumId: "nope" }),
    ).toBe(false);
  });
});
