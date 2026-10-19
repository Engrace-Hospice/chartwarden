// WP 4.12 (ADR-0080) - the read-only on-call directory route over the REAL Authorization Contract: both permissions are required,
// the tenant flag off is the uniform 404, the query is closed (role list, uuid, no unknown key), the answer carries names and no ids,
// and the deny-stub answers "roster not connected" rather than an empty list.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import type { EscalationRouter } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { escalationRouterDenyStub } from "../src/bootstrap/seams/providers";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { createOnCallCoverageService } from "../src/modules/36-messaging/oncall-directory/oncall-coverage-service";
import { registerOnCallRoutes } from "../src/modules/36-messaging/routes/oncall-routes";

type Handler = (r: FastifyRequest, p: FastifyReply) => Promise<void>;

const ORG = "org_a";
const PATIENT = "99999999-9999-4999-8999-000000000001";
const COVERING = "dddddddd-dddd-4ddd-8ddd-000000000001";
const URL = "/api/v1/messaging/oncall/coverage";

// Not in the caller's caseload but in the org (the scope gate denies a caseload-only caller).
const UNASSIGNED_PATIENT = "88888888-8888-4888-8888-000000000002";
// Not in the org at all (another tenant's patient) and one that exists nowhere: patientExists says no to both.
const FOREIGN_PATIENT = "77777777-7777-4777-8777-000000000003";
const GHOST_PATIENT = "66666666-6666-4666-8666-000000000004";
const PATIENTS_IN_ORG = new Set([PATIENT, UNASSIGNED_PATIENT]);
const inserted: unknown[] = [];
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({
    values: async (row: unknown) => {
      inserted.push(row);
    },
  }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

let enabled = true;
let routerCalls = 0;
let router: EscalationRouter = escalationRouterDenyStub;

const service = createOnCallCoverageService({
  isEnabled: async () => enabled,
  router: {
    resolveTier: (org, request) => {
      routerCalls += 1;
      return router.resolveTier(org, request);
    },
  },
  displayName: async () => "Dana K.",
  now: () => new Date("2026-06-01T21:07:00.000Z"),
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  // "supervisor" holds an org-wide scope role: the REAL caseload_or_scope predicate says yes for any well-formed patient id.
  request.context.roles = user === "supervisor" ? ["medical_director"] : [];
  request.context.locationIds = [];
}

const grants = (permissionKeys: string[]) => [
  { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys },
];

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "nurse",
        grants: grants(["messaging.read", "messaging.oncall.read", "patient.read"]),
      },
      {
        orgId: ORG,
        userId: "scopeless",
        grants: grants(["messaging.read", "messaging.oncall.read", "patient.read"]),
      },
      {
        orgId: ORG,
        userId: "no-chart",
        grants: grants(["messaging.read", "messaging.oncall.read"]),
      },
      {
        orgId: ORG,
        userId: "supervisor",
        grants: grants(["messaging.read", "messaging.oncall.read", "patient.read"]),
      },
      { orgId: ORG, userId: "reader", grants: grants(["messaging.read"]) },
      { orgId: ORG, userId: "oncall-only", grants: grants(["messaging.oncall.read"]) },
    ]).store,
  );
  const registry = createPredicateRegistry();
  // The REAL M7 caseload_or_scope predicate over a caseload of one: nurse is on PATIENT only.
  const predicates = buildCarePlanAbacPredicates({
    resolver: { loadPlan: async () => null } as never,
    isInCaseload: async (q) => q.userId === "nurse" && q.patientId === PATIENT,
  });
  registry.register("caseload_or_scope", predicates.caseload_or_scope as never);
  registerAbacRegistry(registry);
  const app = buildServer({
    db: fakeDb,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerOnCallRoutes(
    app,
    { service, patientExists: async (_org, id) => PATIENTS_IN_ORG.has(id) },
    { read: requirePermission("messaging.read") as Handler },
  );
  return app;
}

const get = (app: ReturnType<typeof makeServer>, user: string | null, qs: string) =>
  app.inject({ method: "GET", url: `${URL}${qs}`, headers: user ? { "x-test-user": user } : {} });
const QS = `?role=rn&patient_id=${PATIENT}`;

beforeEach(() => {
  enabled = true;
  routerCalls = 0;
  inserted.length = 0;
  router = escalationRouterDenyStub;
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /messaging/oncall/coverage", () => {
  it("answers 'roster not connected' (unknown, not empty) while only the deny-stub is bound", async () => {
    const res = await get(makeServer(), "nurse", QS);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ role: "rn", status: "roster_not_connected", tiers: [] });
  });

  it("returns names, the roster zone and no user id when a router answers", async () => {
    router = {
      resolveTier: async (_org, request) => ({
        kind: "resolved",
        userIds: [COVERING],
        nextTier: null,
        timeZone: "America/Los_Angeles",
        shiftEndsAt: "2026-06-02T02:00:00Z",
        tier: request.tier,
        asOf: request.asOf,
        source: "m19",
      }),
    };
    const res = await get(makeServer(), "nurse", QS);
    expect(res.json().tiers).toEqual([
      {
        tier: 1,
        state: "covering",
        people: [{ display_name: "Dana K.", rank: "primary" }],
        shift_ends_at: "2026-06-02T02:00:00.000Z",
        time_zone: "America/Los_Angeles",
      },
    ]);
    expect(res.body).not.toContain(COVERING);
    expect(res.body).not.toContain(PATIENT);
  });

  it("is the uniform 404 when the tenant flag is off", async () => {
    enabled = false;
    expect((await get(makeServer(), "nurse", QS)).statusCode).toBe(404);
  });

  it("needs messaging.oncall.read AND messaging.read, and a signed-in caller", async () => {
    const app = makeServer();
    expect((await get(app, "reader", QS)).statusCode).toBe(403);
    expect((await get(app, "oncall-only", QS)).statusCode).toBe(403);
    expect((await get(app, null, QS)).statusCode).toBe(401);
  });

  it("refuses a role outside the closed list, a malformed patient id and an unknown key (422, the repo's validation envelope)", async () => {
    const app = makeServer();
    for (const qs of [
      `?role=admin&patient_id=${PATIENT}`,
      "?role=rn&patient_id=not-a-uuid",
      "?role=rn",
      `?role=rn&patient_id=${PATIENT}&org_id=other`,
    ]) {
      expect((await get(app, "nurse", qs)).statusCode).toBe(422);
    }
  });

  it("answers the identical 404, with no router call and no audit row, for an invisible, other-org and nonexistent patient", async () => {
    const app = makeServer();
    const refused = [
      await get(app, "scopeless", QS), // no caseload on a real patient
      await get(app, "nurse", `?role=rn&patient_id=${UNASSIGNED_PATIENT}`), // real patient, not on the nurse's caseload
      // an org-wide scope role: the real predicate is true for ANY well-formed id, so only the existence check refuses these
      await get(app, "supervisor", `?role=rn&patient_id=${FOREIGN_PATIENT}`),
      await get(app, "supervisor", `?role=rn&patient_id=${GHOST_PATIENT}`),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      expect(res.json().error.message).toBe(refused[0]?.json().error.message);
    }
    expect(routerCalls).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("lets an org-wide caller read a patient that exists in the org and audits it against that patient", async () => {
    const res = await get(makeServer(), "supervisor", `?role=rn&patient_id=${UNASSIGNED_PATIENT}`);
    expect(res.statusCode).toBe(200);
    expect(routerCalls).toBe(1);
    expect(JSON.stringify(inserted)).toContain(UNASSIGNED_PATIENT);
  });

  it("needs the chart-read permission as well", async () => {
    expect((await get(makeServer(), "no-chart", QS)).statusCode).toBe(403);
    expect(routerCalls).toBe(0);
  });

  it("asks the router for a visible patient and audits the read against that patient", async () => {
    const res = await get(makeServer(), "nurse", QS);
    expect(res.statusCode).toBe(200);
    expect(routerCalls).toBe(1);
    expect(JSON.stringify(inserted)).toContain(PATIENT);
    expect(JSON.stringify(inserted)).toContain("oncall_coverage");
  });
});
