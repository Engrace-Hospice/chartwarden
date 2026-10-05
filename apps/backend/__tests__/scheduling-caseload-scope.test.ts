// apps/backend/__tests__/scheduling-caseload-scope.test.ts — GAP-053 (M17): visit list / detail / day / week /
// map views and proposal reads narrow to the caller's caseload (plus visits assigned to the caller);
// `visit.read_team` and org-wide scope roles read the whole org; an off-scope :id is a non-leaking 404.
// Runs the real M3 authorization contract over the in-memory M17 backend (no live infra).
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import {
  SchedulingRouteService,
  buildSchedulingAbacPredicates,
  registerSchedulingRoutes,
} from "../src/modules/17-scheduling/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const RN_Y = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-01T00:00:00.000Z";
const DATE = "2026-07-02";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";

const READ_PERMS = ["visit.read", "visit.proposal.read"];
/** userId → permissions. */
const PERMS: Record<string, string[]> = {
  rn_1: READ_PERMS,
  rn_2: READ_PERMS,
  rn_3: READ_PERMS,
  sched_1: [...READ_PERMS, "visit.read_team"],
  md_1: READ_PERMS,
};
/** userId → the patients on that user's caseload. */
const CASELOAD: Record<string, readonly string[]> = {
  rn_1: [PATIENT],
  rn_2: [],
  rn_3: [],
  sched_1: [],
  md_1: [],
};

function visitInput(patientId: string, assignedMembershipId: string, hour: number) {
  const start = new Date(`${DATE}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  return {
    patientId,
    admissionId: ADMISSION,
    patientAddressId: null,
    externalFacilityId: null,
    assignedMembershipId,
    visitPurpose: "routine_visit" as const,
    visitSetting: "patient_home" as const,
    scheduledStartedAt: start.toISOString(),
    scheduledEndedAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

async function makeServer() {
  const assignees = ["rn_x", "rn_3", RN_Y];
  const backend = new SchedulingRouteService({
    now: () => NOW,
    newId: () => randomUUID(),
    seed: {
      disciplines: Object.fromEntries(assignees.map((m) => [m, "rn" as const])),
      credentialedMemberships: assignees,
      unassignedPoolOrgs: [ORG],
    },
  });
  // Visit A: PATIENT (rn_1's caseload), assigned to somebody else. Visit B: OTHER_PATIENT, assigned to rn_3.
  const visitA = await backend.createVisit(ORG, "seed", visitInput(PATIENT, "rn_x", 9));
  const visitB = await backend.createVisit(ORG, "seed", visitInput(OTHER_PATIENT, "rn_3", 11));
  const visitC = await backend.createVisit(ORG, "seed", visitInput(OTHER_PATIENT, RN_Y, 13));
  (backend as unknown as { proposals: Map<string, unknown> }).proposals.set(randomUUID(), {
    id: randomUUID(),
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    proposedVisitPurpose: "routine_visit",
    proposedForDate: DATE,
    status: "pending",
  });
  (backend as unknown as { proposals: Map<string, unknown> }).proposals.set(randomUUID(), {
    id: randomUUID(),
    organizationId: ORG,
    patientId: OTHER_PATIENT,
    admissionId: ADMISSION,
    proposedVisitPurpose: "routine_visit",
    proposedForDate: DATE,
    status: "pending",
  });

  const store = createInMemoryEffectivePermissionStore(
    Object.entries(PERMS).map(([userId, permissionKeys]) => ({
      orgId: ORG,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    })),
  );
  registerEffectivePermissionResolver(store.store);
  const reg = createPredicateRegistry();
  const m7 = buildCarePlanAbacPredicates({
    resolver: {
      loadPlan: async () => null,
      loadProblem: async () => null,
      loadVersion: async () => null,
    },
    isInCaseload: async (q) => (CASELOAD[q.userId] ?? []).includes(q.patientId),
  });
  reg.register("caseload_or_scope", m7.caseload_or_scope);
  for (const [name, fn] of Object.entries(buildSchedulingAbacPredicates({ resolver: backend }))) {
    reg.register(name, fn);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSchedulingRoutes(app, {
    service: backend,
    caseloadPatientIds: async ({ userId }) => CASELOAD[userId] ?? [],
  });
  return { app, backend, visitA: visitA.id, visitB: visitB.id, visitC: visitC.id };
}

const as = (user: string, roles = "rn_case_manager") => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
});

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

const ids = (res: { json: () => unknown }) =>
  (res.json() as Array<{ id: string }>).map((v) => v.id);

describe("GAP-053 — GET /visits", () => {
  it("returns only visits on the caller's caseload", async () => {
    const s = await makeServer();
    const res = await s.app.inject({ method: "GET", url: "/api/v1/visits", headers: as("rn_1") });
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([s.visitA]);
    await s.app.close();
  });

  it("returns an empty list for a clinician with an empty caseload and no assignments", async () => {
    const s = await makeServer();
    const res = await s.app.inject({ method: "GET", url: "/api/v1/visits", headers: as("rn_2") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await s.app.close();
  });

  it("also returns visits assigned to the caller even when the patient is off-caseload", async () => {
    const s = await makeServer();
    const res = await s.app.inject({ method: "GET", url: "/api/v1/visits", headers: as("rn_3") });
    expect(ids(res)).toEqual([s.visitB]);
    await s.app.close();
  });

  it("returns the whole org to a visit.read_team holder", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/visits",
      headers: as("sched_1", "scheduler"),
    });
    expect(ids(res).sort()).toEqual([s.visitA, s.visitB, s.visitC].sort());
    await s.app.close();
  });

  it("returns the whole org to an org-wide scope role", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/visits",
      headers: as("md_1", "medical_director"),
    });
    expect(ids(res)).toHaveLength(3);
    await s.app.close();
  });
});

describe("GAP-053 — GET /visits/:visitId", () => {
  it("returns an on-caseload visit", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/visits/${s.visitA}`,
      headers: as("rn_1"),
    });
    expect(res.statusCode).toBe(200);
    await s.app.close();
  });

  it("returns an own-assigned visit for an off-caseload patient", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/visits/${s.visitB}`,
      headers: as("rn_3"),
    });
    expect(res.statusCode).toBe(200);
    await s.app.close();
  });

  it("404s an off-scope visit, indistinguishable from a missing one", async () => {
    const s = await makeServer();
    const off = await s.app.inject({
      method: "GET",
      url: `/api/v1/visits/${s.visitA}`,
      headers: as("rn_2"),
    });
    const missing = await s.app.inject({
      method: "GET",
      url: `/api/v1/visits/${MISSING_ID}`,
      headers: as("rn_2"),
    });
    expect(off.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    await s.app.close();
  });

  it("lets a visit.read_team holder read any visit", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/visits/${s.visitA}`,
      headers: as("sched_1", "scheduler"),
    });
    expect(res.statusCode).toBe(200);
    await s.app.close();
  });
});

describe("GAP-053 — day / week / map views", () => {
  it("day-view without a membership is scoped to the caseload", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/day-view?date=${DATE}`,
      headers: as("rn_1"),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().visits as Array<{ id: string }>).map((v) => v.id)).toEqual([s.visitA]);
    await s.app.close();
  });

  it("day-view for an empty-caseload clinician is empty", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/day-view?date=${DATE}`,
      headers: as("rn_2"),
    });
    expect(res.json().visits).toEqual([]);
    await s.app.close();
  });

  it("week-view without a membership is scoped to the caseload", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/week-view?weekStart=${DATE}`,
      headers: as("rn_1"),
    });
    expect((res.json().visits as Array<{ id: string }>).map((v) => v.id)).toEqual([s.visitA]);
    await s.app.close();
  });

  it("week-view stays org-wide for a visit.read_team holder", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/week-view?weekStart=${DATE}`,
      headers: as("sched_1", "scheduler"),
    });
    expect(res.json().visits).toHaveLength(3);
    await s.app.close();
  });

  it("map-view hides stops for patients outside the caller's scope", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: `/api/v1/map-view?membership=${RN_Y}&date=${DATE}`,
      headers: as("rn_1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stops).toEqual([]);
    await s.app.close();
  });
});

describe("GAP-053 — GET /visit-proposals", () => {
  it("narrows proposals to the caller's caseload", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/visit-proposals",
      headers: as("rn_1"),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ patientId: string }>).map((p) => p.patientId)).toEqual([PATIENT]);
    await s.app.close();
  });

  it("returns nothing to an empty-caseload clinician", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/visit-proposals",
      headers: as("rn_2"),
    });
    expect(res.json()).toEqual([]);
    await s.app.close();
  });

  it("returns every proposal to a visit.read_team holder", async () => {
    const s = await makeServer();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/v1/visit-proposals",
      headers: as("sched_1", "scheduler"),
    });
    expect(res.json()).toHaveLength(2);
    await s.app.close();
  });
});
