// WP 3.1 - GET /patients/:patientId/context: each tile re-checks the owning module's permission on the request, a
// denied tile is ABSENT (and its seam never called), and a caller who may see no tile cannot tell a missing patient
// from a real one.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  requirePermission,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import type { MedicationOrderDto, PatientIdentity } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { PatientContextPorts } from "../src/modules/36-messaging/patient-context/patient-context-service";
import { registerPatientContextRoutes } from "../src/modules/36-messaging/routes/patient-context-routes";

const ORG = "org_a";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-00000000d1d1";
const MISSING = "bbbbbbbb-bbbb-4bbb-8bbb-00000000d1d1";
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({ values: async () => undefined }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

let medsCalls = 0;
let taskCalls: Array<[string, string, string]> = [];
let tasksFlag = false;
const ports: PatientContextPorts = {
  findPatient: async (_o, id) =>
    id === PATIENT ? ({ id, organizationId: ORG, status: "active" } as PatientIdentity) : null,
  careTeamMembers: async () => ["rn_1"],
  activeAllergies: async () => [],
  activeMedications: async () => {
    medsCalls += 1;
    return [{}, {}] as MedicationOrderDto[];
  },
  openTaskCount: async (org, patient, user) => {
    taskCalls.push([org, patient, user]);
    return 3;
  },
  now: () => new Date("2026-10-14T12:00:00.000Z"),
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.locationIds = [];
}

const KEYS: Record<string, string[]> = {
  nurse: ["messaging.read", "patient.read", "prescribing.read"],
  aide: ["messaging.read", "patient.read"],
  outsider: ["messaging.read"],
  // holds the keys but is out of scope for the patient (caseload_or_scope denies)
  scopeless: ["messaging.read", "patient.read", "prescribing.read"],
  // medication access without chart access
  prescriber: ["messaging.read", "prescribing.read"],
};

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
  registry.register(
    "caseload_or_scope",
    async (ctx, target) => ctx.userId !== "scopeless" && target.patientId === PATIENT,
  );
  registerAbacRegistry(registry);
  const app = buildServer({
    db: fakeDb,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerPatientContextRoutes(
    app,
    {
      read: requirePermission("messaging.read") as (
        r: FastifyRequest,
        p: FastifyReply,
      ) => Promise<void>,
    },
    ports,
    async () => tasksFlag,
  );
  return app;
}
const get = (app: ReturnType<typeof makeServer>, user: string | null, id = PATIENT) =>
  app.inject({
    method: "GET",
    url: `/api/v1/messaging/patients/${id}/context`,
    headers: user ? { "x-test-user": user } : {},
  });

beforeEach(() => {
  medsCalls = 0;
  taskCalls = [];
  tasksFlag = false;
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("GET /patients/:patientId/context", () => {
  it("returns all four tiles to a user who holds both chart and medication access", async () => {
    const app = makeServer();
    const res = await get(app, "nurse");
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().tiles).sort()).toEqual([
      "allergies",
      "care_team",
      "medications",
      "status",
    ]);
    await app.close();
  });

  it("gives a user without medication access no medication tile and never calls the medication seam", async () => {
    const app = makeServer();
    const res = await get(app, "aide");
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().tiles).sort()).toEqual(["allergies", "care_team", "status"]);
    expect(medsCalls).toBe(0);
    await app.close();
  });

  it("answers a user with no tile access identically for a real and a missing patient", async () => {
    const app = makeServer();
    const real = await get(app, "outsider");
    const missing = await get(app, "outsider", MISSING);
    expect(real.statusCode).toBe(200);
    expect(real.json().tiles).toEqual({});
    expect(missing.statusCode).toBe(200);
    expect(missing.json().tiles).toEqual({});
    await app.close();
  });

  it("is 401 anonymous and 404 for a malformed id", async () => {
    const app = makeServer();
    expect((await get(app, null)).statusCode).toBe(401);
    expect((await get(app, "nurse", "nope")).statusCode).toBe(404);
    await app.close();
  });

  it("denies every tile to a user who holds the keys but fails the caseload scope", async () => {
    const app = makeServer();
    const res = await get(app, "scopeless");
    expect(res.statusCode).toBe(200);
    expect(res.json().tiles).toEqual({});
    expect(medsCalls).toBe(0);
    await app.close();
  });

  it("gives medication access alone only the medication tile", async () => {
    const app = makeServer();
    const res = await get(app, "prescriber");
    expect(Object.keys(res.json().tiles)).toEqual(["medications"]);
    await app.close();
  });

  it("omits the open-tasks tile and never counts while the tenant flag is off", async () => {
    const app = makeServer();
    const res = await get(app, "nurse");
    expect("open_tasks" in res.json().tiles).toBe(false);
    expect(taskCalls).toEqual([]);
    await app.close();
  });

  it("returns the caller's own open-task count once the flag is on", async () => {
    tasksFlag = true;
    const app = makeServer();
    const res = await get(app, "nurse");
    expect(res.json().tiles.open_tasks).toMatchObject({
      state: "ok",
      data: { count: 3 },
      link: "/notifications?tab=tasks",
    });
    expect(taskCalls).toEqual([[ORG, PATIENT, "nurse"]]);
    await app.close();
  });

  it("keeps the tile behind the chart-read gate even with the flag on", async () => {
    tasksFlag = true;
    const app = makeServer();
    for (const user of ["outsider", "scopeless", "prescriber"]) {
      const res = await get(app, user);
      expect("open_tasks" in res.json().tiles).toBe(false);
    }
    expect(taskCalls).toEqual([]);
    await app.close();
  });
});
