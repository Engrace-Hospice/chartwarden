// apps/backend/__tests__/idg-enrichment.test.ts — the IDG meeting-screen READ enrichment, through the full
// M1 middleware chain via Fastify `inject` (no live infra):
//   1. patient display info ("First L." + MRN last-4) on the agenda / packet / decision / action-item reads,
//      resolved with ONE batched port call per response (no N+1), `patient: null` for an unresolvable id, and
//      graceful degradation (ids only, never a 500) when the port is absent or throws;
//   2. the meeting-scoped recert/F2F windows read (GET /idg/meetings/:id/recert-windows): patient set = agenda
//      ∪ packets, one batched M6 port call, `unknown` rows (never fabricated) for a patient M6 cannot resolve.
// The REAL Authorization Contract gates every route (idg.read + idg_meeting_scope).
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
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import {
  type IdgPatientDisplayPort,
  type IdgRecertWindowFact,
  type IdgRecertWindowPort,
  buildIdgAbacPredicates,
  createInMemoryIdgBackend,
  registerIdgRoutes,
} from "../src/modules/14-idg/index";

// GAP-128 - these suites exercise other behavior; the per-patient caseload scope is covered in idg-caseload-scope.test.ts.
const COVERS_EVERY_PATIENT = async (): Promise<readonly string[]> =>
  ({ includes: () => true }) as unknown as readonly string[];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
}

const ORG = "org_a";
const LOC = "44444444-4444-4444-8444-444444444444";
const MTG = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const P_UNKNOWN = "55555555-5555-4555-8555-555555555555";
const HEADERS = {
  "x-test-user": "clinician",
  "x-test-org": ORG,
  "x-test-roles": "idg_coordinator",
  "x-test-locations": LOC,
};

const WINDOW_P1: IdgRecertWindowFact = {
  patientId: P1,
  admissionId: "66666666-6666-4666-8666-666666666666",
  currentPeriodSequence: 2,
  benefitPeriodStart: "2026-07-01",
  benefitPeriodEnd: "2026-09-28",
  nextRecertDueDate: "2026-09-29",
  nextPeriodSequence: 3,
  daysUntilNextRecert: 0,
  f2fRequired: true,
  f2fWindowStart: "2026-08-30",
  f2fWindowEnd: "2026-09-28",
  f2fStatus: "window_open",
  f2fWindowState: "window_open",
  f2fScheduledDate: null,
};

function makeServer(opts: {
  patientDisplay?: IdgPatientDisplayPort;
  recertWindows?: IdgRecertWindowPort;
}) {
  const backend = createInMemoryIdgBackend({
    meetings: [
      {
        id: MTG,
        organizationId: ORG,
        locationId: LOC,
        status: "live",
        scheduledStart: "2026-06-22T14:00:00.000Z",
        scheduledEnd: "2026-06-22T16:00:00.000Z",
        includedPatientIds: [P1, P2],
      },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "clinician",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["idg.read", "idg.coordinate", "idg.act"],
          },
        ],
      },
    ]).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(buildIdgAbacPredicates({ resolver: backend }))) {
    registry.register(name, fn);
  }
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerIdgRoutes(app, { service: backend, enrichment: opts, caseload: COVERS_EVERY_PATIENT });
  return { app };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  __resetSeamsForTest();
});

/** A display port that knows P1 + P2 (not P_UNKNOWN) and records every call. */
function countingDisplayPort() {
  const calls: string[][] = [];
  const port: IdgPatientDisplayPort = {
    async displayForPatients(_org, ids) {
      calls.push([...ids]);
      const known: Record<string, { displayName: string; mrnSuffix: string | null }> = {
        [P1]: { displayName: "Ada L.", mrnSuffix: "0042" },
        [P2]: { displayName: "Bo K.", mrnSuffix: null },
      };
      return new Map(ids.filter((i) => known[i]).map((i) => [i, known[i]!] as const));
    },
  };
  return { port, calls };
}

describe("patient display enrichment on the meeting reads", () => {
  it("packets list: attaches patient display with ONE batched lookup", async () => {
    const { port, calls } = countingDisplayPort();
    const { app } = makeServer({ patientDisplay: port });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/packets`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ patientId: string; patient: unknown }>;
    expect(body).toHaveLength(2);
    expect(body.find((b) => b.patientId === P1)?.patient).toEqual({
      displayName: "Ada L.",
      mrnSuffix: "0042",
    });
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set([P1, P2]));
    await app.close();
  });

  it("single packet read is enriched too", async () => {
    const { port } = countingDisplayPort();
    const { app } = makeServer({ patientDisplay: port });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/packets/${P1}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().patient).toEqual({ displayName: "Ada L.", mrnSuffix: "0042" });
    await app.close();
  });

  it("agenda list: patient-less items get patient:null, unknown ids get patient:null, known get the label", async () => {
    const { port, calls } = countingDisplayPort();
    const { app } = makeServer({ patientDisplay: port });
    for (const payload of [
      { kind: "patient_review", patientId: P1 },
      { kind: "patient_review", patientId: P_UNKNOWN },
      { kind: "administrative_note" },
    ]) {
      const add = await app.inject({
        method: "POST",
        url: `/api/v1/idg/meetings/${MTG}/agenda`,
        headers: HEADERS,
        payload,
      });
      expect(add.statusCode).toBe(201);
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/agenda`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ patientId: string | null; patient: unknown }>;
    expect(items.find((i) => i.patientId === P1)?.patient).toEqual({
      displayName: "Ada L.",
      mrnSuffix: "0042",
    });
    expect(items.find((i) => i.patientId === P_UNKNOWN)?.patient).toBeNull();
    expect(items.find((i) => i.patientId === null)?.patient).toBeNull();
    expect(calls).toHaveLength(1); // the whole agenda in one lookup
    expect(new Set(calls[0])).toEqual(new Set([P1, P_UNKNOWN]));
    await app.close();
  });

  it("degrades to ids only (no `patient` key, still 200) when the port throws", async () => {
    const { app } = makeServer({
      patientDisplay: {
        async displayForPatients() {
          throw new Error("m5 down");
        },
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/packets`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect("patient" in body[0]!).toBe(false);
    await app.close();
  });

  it("leaves the read untouched (no `patient` key) when no port is bound", async () => {
    const { app } = makeServer({});
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/packets`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect("patient" in (res.json() as Array<Record<string, unknown>>)[0]!).toBe(false);
    await app.close();
  });
});

describe("GET /idg/meetings/:id/recert-windows", () => {
  it("returns one row per agenda ∪ packet patient from ONE M6 call, `unknown` for an unresolved patient", async () => {
    const recertCalls: string[][] = [];
    const { port } = countingDisplayPort();
    const { app } = makeServer({
      patientDisplay: port,
      recertWindows: {
        async recertWindowsForPatients(_org, ids) {
          recertCalls.push([...ids]);
          return new Map([[P1, WINDOW_P1]]);
        },
      },
    });
    // P_UNKNOWN is on the agenda only (no packet); P1/P2 have packets.
    await app.inject({
      method: "POST",
      url: `/api/v1/idg/meetings/${MTG}/agenda`,
      headers: HEADERS,
      payload: { kind: "patient_review", patientId: P_UNKNOWN },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/recert-windows`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meetingId: string;
      generatedAt: string;
      items: Array<Record<string, unknown>>;
    };
    expect(body.meetingId).toBe(MTG);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.items.map((i) => i.patientId).sort()).toEqual([P1, P2, P_UNKNOWN].sort());
    expect(recertCalls).toHaveLength(1);

    const p1 = body.items.find((i) => i.patientId === P1)!;
    expect(p1).toMatchObject({
      admissionId: WINDOW_P1.admissionId,
      nextRecertDueDate: "2026-09-29",
      benefitPeriodEnd: "2026-09-28",
      f2fStatus: "window_open",
      f2fWindowState: "window_open",
      f2fWindowStart: "2026-08-30",
      f2fWindowEnd: "2026-09-28",
      patient: { displayName: "Ada L.", mrnSuffix: "0042" },
    });
    const p2 = body.items.find((i) => i.patientId === P2)!;
    expect(p2).toMatchObject({
      admissionId: null,
      nextRecertDueDate: null,
      f2fStatus: "unknown",
      f2fWindowState: null,
    });
    await app.close();
  });

  it("degrades to `unknown` rows (200) when the M6 port throws or is unbound", async () => {
    for (const recertWindows of [
      {
        async recertWindowsForPatients(): Promise<ReadonlyMap<string, IdgRecertWindowFact>> {
          throw new Error("m6 down");
        },
      },
      undefined,
    ]) {
      const { app } = makeServer({ recertWindows });
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/idg/meetings/${MTG}/recert-windows`,
        headers: HEADERS,
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ f2fStatus: string }>;
      expect(items.length).toBe(2);
      expect(items.every((i) => i.f2fStatus === "unknown")).toBe(true);
      await app.close();
    }
  });

  it("404s a meeting in another org (no existence leak)", async () => {
    const { app } = makeServer({});
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/recert-windows`,
      headers: { ...HEADERS, "x-test-org": "org_b" },
    });
    expect([403, 404]).toContain(res.statusCode);
    await app.close();
  });

  it("is denied without idg.read (403)", async () => {
    const { app } = makeServer({});
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/idg/meetings/${MTG}/recert-windows`,
      headers: { ...HEADERS, "x-test-user": "nobody" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
