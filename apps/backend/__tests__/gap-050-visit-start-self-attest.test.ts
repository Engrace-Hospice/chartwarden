// apps/backend/__tests__/gap-050-visit-start-self-attest.test.ts — GAP-050 (M17): the HTTP visit start / arrive
// routes are ALWAYS the documented self-attest path (a >= 40-char reason + a fresh server-side step-up) and only
// the assigned clinician may use them. `via:'evv'` (EVV-present) advances only from the M18 consumers.
// Runs the real M3 authorization contract + M2's real SessionContextResolver over the in-memory M17 backend.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import {
  SchedulingRouteService,
  buildSchedulingAbacPredicates,
  registerSchedulingRoutes,
} from "../src/modules/17-scheduling/index";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const RN = "33333333-3333-4333-8333-333333333333";
const OTHER_RN = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-01T00:00:00.000Z";
const SESSION_FRESH = "sess_fresh";
const SESSION_STALE = "sess_stale";
const REASON = "x".repeat(40);

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["clinician"];
  const session = request.headers["x-test-session"];
  if (typeof session === "string") request.context.attributes.sessionId = session;
}

const as = (user: string, session = SESSION_FRESH) => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-session": session,
});

function sessionRow(sessionId: string, lastStepUpAt: Date) {
  return {
    providerEntityIds: [],
    locationIds: [],
    sessionClass: "staff" as const,
    portalAccountId: null,
    sessionPatientId: null,
    sessionId,
    userId: RN,
    membershipId: RN,
    organizationId: ORG,
    roles: ["clinician"],
    lastStepUpAt,
    lastStepUpFactor: "webauthn" as const,
  };
}

async function makeServer() {
  const backend = new SchedulingRouteService({
    now: () => NOW,
    newId: () => randomUUID(),
    seed: {
      disciplines: { [RN]: "rn", [OTHER_RN]: "rn" },
      credentialedMemberships: [RN, OTHER_RN],
      unassignedPoolOrgs: [ORG],
    },
  });
  const visit = await backend.createVisit(ORG, "seed", {
    patientId: PATIENT,
    admissionId: ADMISSION,
    patientAddressId: null,
    externalFacilityId: null,
    assignedMembershipId: RN,
    visitPurpose: "routine_visit",
    visitSetting: "patient_home",
    scheduledStartedAt: "2026-07-02T09:00:00.000Z",
    scheduledEndedAt: "2026-07-02T10:00:00.000Z",
  });
  const grants = (userId: string) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["visit.start"] }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([grants(RN), grants(OTHER_RN)]).store,
  );
  const { store } = createInMemorySessionContextStore([
    sessionRow(SESSION_FRESH, new Date(Date.now() - 60_000)),
    sessionRow(SESSION_STALE, new Date(Date.now() - 3_600_000)),
  ]);
  registerSeam("SessionContextResolver", createSessionContextResolver(store));
  const reg = createPredicateRegistry();
  reg.register(
    "caseload_or_scope",
    buildCarePlanAbacPredicates({
      resolver: {
        loadPlan: async () => null,
        loadProblem: async () => null,
        loadVersion: async () => null,
      },
      isInCaseload: async () => true,
    }).caseload_or_scope,
  );
  for (const [name, predicate] of Object.entries(
    buildSchedulingAbacPredicates({ resolver: backend }),
  )) {
    reg.register(name, predicate);
  }
  registerAbacRegistry(reg);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerSchedulingRoutes(app, { service: backend, caseloadPatientIds: async () => [PATIENT] });
  return { app, backend, visitId: visit.id };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});

describe.each(["start", "arrive"] as const)("GAP-050 — POST /visits/:id/%s", (action) => {
  const post = (
    app: Awaited<ReturnType<typeof makeServer>>["app"],
    id: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) => app.inject({ method: "POST", url: `/api/v1/visits/${id}/${action}`, headers, payload });

  it("rejects an empty body with 422 (no EVV-present shortcut)", async () => {
    const { app, visitId } = await makeServer();
    const res = await post(app, visitId, as(RN), {});
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("rejects a reason shorter than 40 characters with 422", async () => {
    const { app, visitId } = await makeServer();
    const res = await post(app, visitId, as(RN), { evvMissingReason: "short" });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("returns 403 for a visit.start holder who is not the assigned clinician", async () => {
    const { app, visitId } = await makeServer();
    const res = await post(app, visitId, as(OTHER_RN), { evvMissingReason: REASON });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("refuses the assignee without a fresh step-up", async () => {
    const { app, backend, visitId } = await makeServer();
    if (action === "arrive") backend.advanceFromEvv(ORG, visitId, "start"); // arrive needs en_route
    const res = await post(app, visitId, as(RN, SESSION_STALE), { evvMissingReason: REASON });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toContain("EVV_SELF_ATTEST_STEP_UP_REQUIRED");
    await app.close();
  });

  it("returns 404 for an unknown visit", async () => {
    const { app } = await makeServer();
    const res = await post(app, randomUUID(), as(RN), { evvMissingReason: REASON });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GAP-050 — success path and service layer", () => {
  it("lets the assignee start with a reason and a fresh step-up", async () => {
    const { app, visitId } = await makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/visits/${visitId}/start`,
      headers: as(RN),
      payload: { evvMissingReason: REASON },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("en_route");
    await app.close();
  });

  it("the service layer itself refuses a non-assignee (defence in depth behind the route predicate)", async () => {
    const { app, backend, visitId } = await makeServer();
    expect(() => backend.startVisit(ORG, OTHER_RN, visitId, REASON, true)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("ASSIGNED_CLINICIAN_REQUIRED") }),
    );
    expect(() => backend.arriveVisit(ORG, OTHER_RN, visitId, REASON, true)).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("ASSIGNED_CLINICIAN_REQUIRED") }),
    );
    await app.close();
  });

  it("the M18-consumer path still advances via EVV without a reason or an assignee check", async () => {
    const { app, backend, visitId } = await makeServer();
    expect(backend.advanceFromEvv(ORG, visitId, "start").status).toBe("en_route");
    expect(backend.advanceFromEvv(ORG, visitId, "arrive").status).toBe("in_visit");
    await app.close();
  });
});
