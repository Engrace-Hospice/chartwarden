// apps/backend/__tests__/m5-assignment-routes.test.ts — GAP-015: the M5 §4.3 assignment routes
// (GET/POST /patients/:id/assignments, POST .../:assignmentId/end). Route layer only: permission +
// the REAL `caseload_or_scope` predicate + request validation + typed-error → HTTP mapping, over an
// injected in-memory port. The Drizzle port (duplicate/primary_rn rules, outbox, RLS) is proven live in
// `m5-assignment-routes.live.test.ts`.
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type AssignClinicianInput,
  AssignmentAlreadyEndedError,
  AssignmentAlreadyOpenError,
  AssignmentEndBeforeStartError,
  AssignmentNotFoundError,
  AssignmentPatientNotFoundError,
  type AssignmentView,
  ClinicianNotInOrgError,
  type PatientAssignmentsPort,
  PrimaryRnAlreadyAssignedError,
} from "../src/modules/05-patient/assignments";
import { registerPatientAssignmentRoutes } from "../src/modules/05-patient/routes/assignment-routes";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "pat-1";
const CLINICIAN = "5f1c0b2e-6a43-4d0e-9a53-0d6c1f9a7b11";

const PERMISSION_SEED = [
  { userId: "don_1", permissions: ["patient.read", "patient.assign"] },
  { userId: "rn_1", permissions: ["patient.read"] },
  { userId: "assigner_off_1", permissions: ["patient.read", "patient.assign"] },
  { userId: "noperm_1", permissions: [] },
];
/** Open assignments the REAL `caseload_or_scope` predicate resolves. DON is on the chart; off-caseload is not. */
const CASELOAD = new Set([`${ORG}:don_1:${PATIENT}`, `${ORG}:rn_1:${PATIENT}`]);

const DON = { "x-test-user": "don_1", "x-test-org": ORG, "x-test-roles": "rn" };
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const OFF = { "x-test-user": "assigner_off_1", "x-test-org": ORG, "x-test-roles": "rn" };
const NOPERM = { "x-test-user": "noperm_1", "x-test-org": ORG, "x-test-roles": "intern" };

const view = (over: Partial<AssignmentView> = {}): AssignmentView => ({
  id: "asg-1",
  patientId: PATIENT,
  clinicianUserId: CLINICIAN,
  role: "primary_rn",
  assignedAt: "2026-10-04",
  unassignedAt: null,
  reason: null,
  current: true,
  ...over,
});

interface Calls {
  assign: { patientId: string; input: AssignClinicianInput; actor: string }[];
  end: { patientId: string; assignmentId: string; actor: string }[];
}

function makeServer(port: Partial<PatientAssignmentsPort> = {}) {
  const calls: Calls = { assign: [], end: [] };
  const full: PatientAssignmentsPort = {
    async list() {
      return [view()];
    },
    async assign(_org, patientId, input, actor) {
      calls.assign.push({ patientId, input, actor });
      return view({ role: input.role });
    },
    async end(_org, patientId, assignmentId, _input, actor) {
      calls.end.push({ patientId, assignmentId, actor });
      return view({ unassignedAt: "2026-10-05", current: false });
    },
    ...port,
  };
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  registerAbacRegistry();
  const predicates = buildCarePlanAbacPredicates({
    resolver: {
      async loadPlan() {
        return null;
      },
      async loadProblem() {
        return null;
      },
      async loadVersion() {
        return null;
      },
    },
    async isInCaseload({ organizationId, userId, patientId }) {
      return CASELOAD.has(`${organizationId}:${userId}:${patientId}`);
    },
  });
  registerPredicateIdempotent("caseload_or_scope", predicates.caseload_or_scope);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerPatientAssignmentRoutes(app, { assignments: full });
  return { app, calls };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

const BODY = { clinicianUserId: CLINICIAN, role: "primary_rn" };
const POST = (headers: Record<string, string>, payload: unknown = BODY, id = PATIENT) => ({
  method: "POST" as const,
  url: `/api/v1/patients/${id}/assignments`,
  headers,
  payload: payload as Record<string, unknown>,
});
const END = (headers: Record<string, string>, payload?: Record<string, unknown>, id = PATIENT) => ({
  method: "POST" as const,
  url: `/api/v1/patients/${id}/assignments/asg-1/end`,
  headers,
  ...(payload ? { payload } : {}),
});

describe("GAP-015 — GET /patients/:id/assignments", () => {
  it("lists a patient's assignments for a caseload clinician holding patient.read", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/assignments`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toHaveLength(1);
    await app.close();
  });

  it("returns 404 for an off-caseload actor (no existence leak)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/assignments`,
      headers: OFF,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 when the port reports the patient absent", async () => {
    const { app } = makeServer({
      async list() {
        return null;
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/assignments`,
      headers: DON,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-015 — POST /patients/:id/assignments", () => {
  it("assigns a clinician (201), passing org-bound actor and parsed body to the port", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(POST(DON));
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("primary_rn");
    expect(calls.assign).toEqual([{ patientId: PATIENT, input: BODY, actor: "don_1" }]);
    await app.close();
  });

  it("denies a holder of patient.read without patient.assign (403)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(POST(RN));
    expect(res.statusCode).toBe(403);
    expect(calls.assign).toHaveLength(0);
    await app.close();
  });

  it("denies an actor with no permissions (403)", async () => {
    const { app } = makeServer();
    expect((await app.inject(POST(NOPERM))).statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 when the assigner holds patient.assign but is not on the chart (caseload_or_scope)", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(POST(OFF));
    expect(res.statusCode).toBe(404);
    expect(calls.assign).toHaveLength(0);
    await app.close();
  });

  it("rejects the system-only admitting_staff role (422): it is an access grant, never assigned by hand", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(POST(DON, { ...BODY, role: "admitting_staff" }));
    expect(res.statusCode).toBe(422);
    expect(calls.assign).toHaveLength(0);
    await app.close();
  });

  it("rejects an unknown role and a non-uuid clinician (422)", async () => {
    const { app } = makeServer();
    expect((await app.inject(POST(DON, { ...BODY, role: "janitor" }))).statusCode).toBe(422);
    expect(
      (await app.inject(POST(DON, { ...BODY, clinicianUserId: "not-a-uuid" }))).statusCode,
    ).toBe(422);
    await app.close();
  });

  it.each([
    [new PrimaryRnAlreadyAssignedError(PATIENT), 409, "PRIMARY_RN_ALREADY_ASSIGNED"],
    [new AssignmentAlreadyOpenError(CLINICIAN, "np"), 409, "ASSIGNMENT_ALREADY_OPEN"],
    [new ClinicianNotInOrgError(CLINICIAN), 422, "CLINICIAN_NOT_IN_ORG"],
    [new AssignmentPatientNotFoundError(PATIENT), 404, "NOT_FOUND"],
  ])("maps %s to %i %s", async (error, status, code) => {
    const { app } = makeServer({
      async assign() {
        throw error;
      },
    });
    const res = await app.inject(POST(DON));
    expect(res.statusCode).toBe(status);
    expect(JSON.stringify(res.json())).toContain(code);
    await app.close();
  });
});

describe("GAP-015 — POST /patients/:id/assignments/:assignmentId/end", () => {
  it("ends an assignment (200) with no body", async () => {
    const { app, calls } = makeServer();
    const res = await app.inject(END(DON));
    expect(res.statusCode).toBe(200);
    expect(res.json().current).toBe(false);
    expect(calls.end).toEqual([{ patientId: PATIENT, assignmentId: "asg-1", actor: "don_1" }]);
    await app.close();
  });

  it("denies without patient.assign (403) and off-caseload (404)", async () => {
    const { app } = makeServer();
    expect((await app.inject(END(RN))).statusCode).toBe(403);
    expect((await app.inject(END(OFF))).statusCode).toBe(404);
    await app.close();
  });

  it("rejects a malformed unassignedAt (422)", async () => {
    const { app } = makeServer();
    expect((await app.inject(END(DON, { unassignedAt: "yesterday" }))).statusCode).toBe(422);
    await app.close();
  });

  it.each([
    [new AssignmentNotFoundError("asg-1"), 404, "NOT_FOUND"],
    [new AssignmentAlreadyEndedError("asg-1"), 409, "ASSIGNMENT_ALREADY_ENDED"],
    [
      new AssignmentEndBeforeStartError("2026-10-04", "2026-10-01"),
      422,
      "ASSIGNMENT_END_BEFORE_START",
    ],
  ])("maps %s to %i %s", async (error, status, code) => {
    const { app } = makeServer({
      async end() {
        throw error;
      },
    });
    const res = await app.inject(END(DON));
    expect(res.statusCode).toBe(status);
    expect(JSON.stringify(res.json())).toContain(code);
    await app.close();
  });
});
