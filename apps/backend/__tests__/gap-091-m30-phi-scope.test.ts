// GAP-091 — the M30 PHI routes (incident / mortality / infection event) compose a SERVER-derived patient
// scope. The read service receives the scope the resolver derives from the session (never the query), a
// create for a patient outside that scope is a 404 that never reaches the write service, and the cursor +
// limit reach the service so paging is the repo's job, not a fixed in-memory window.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { M30_PERMISSION_KEY_LIST, mountM30Routes } from "../src/modules/30-quality/index";
import type { M30ReadActor } from "../src/modules/30-quality/routes/actor";
import type { QualityPatientScope } from "../src/modules/30-quality/routes/patient-scope";
import type {
  IncidentDetailView,
  InfectionEventView,
  M30ReadRouteService,
} from "../src/modules/30-quality/routes/read-service";
import type { M30WriteRouteService } from "../src/modules/30-quality/routes/write-service";

const ORG = "org_a";
const P_IN = "10101010-1010-4101-8101-101010101010";
const P_OUT = "20202020-2020-4202-8202-202020202020";
const NOW = "2026-08-04T12:00:00.000Z";
const HEADERS = {
  "x-test-user": "nurse_1",
  "x-test-org": ORG,
  "x-test-roles": "rn_case_manager",
  "x-test-membership": "88888888-8888-4888-8888-888888888888",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = String(request.headers["x-test-roles"] ?? "");
  request.context.roles = roles ? roles.split(",") : [];
  request.context.attributes.membershipId = String(request.headers["x-test-membership"] ?? "");
  request.context.attributes.stepUpRecent = true;
}

interface Capture {
  listScopes: QualityPatientScope[];
  detailScopes: QualityPatientScope[];
  listArgs: { cursor: string | undefined; limit: number | undefined }[];
  resolvedFor: M30ReadActor[];
  created: number;
}

function makeServer(scope: QualityPatientScope) {
  const cap: Capture = {
    listScopes: [],
    detailScopes: [],
    listArgs: [],
    resolvedFor: [],
    created: 0,
  };
  const page = { items: [], nextCursor: null, hasMore: false };
  const readService: Pick<
    M30ReadRouteService,
    "listIncidents" | "getIncident" | "listMortalityReviews" | "listInfectionEvents"
  > = {
    async listIncidents(_a, _f, cursor, limit, s) {
      cap.listScopes.push(s);
      cap.listArgs.push({ cursor, limit });
      return page;
    },
    async getIncident(_a, _id, s) {
      cap.detailScopes.push(s);
      throw new Error("not-needed");
    },
    async listMortalityReviews(_a, _f, _c, _l, s) {
      cap.listScopes.push(s);
      return page;
    },
    async listInfectionEvents(_a, _f, _c, _l, s) {
      cap.listScopes.push(s);
      return page;
    },
  };
  const writeService: Pick<M30WriteRouteService, "createIncident" | "recordInfectionEvent"> = {
    async createIncident() {
      cap.created += 1;
      return { incidentId: "i1" } as IncidentDetailView;
    },
    async recordInfectionEvent() {
      cap.created += 1;
      return { eventId: "e1" } as InfectionEventView;
    },
  };

  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "nurse_1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [...M30_PERMISSION_KEY_LIST],
          },
        ],
      },
    ]).store,
  );
  const reg = createPredicateRegistry();
  for (const n of ["ownsIncident", "incidentVisibility", "assignedToIncident"]) {
    reg.register(n, async () => true);
  }
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM30Routes(app, {
    readService: readService as M30ReadRouteService,
    writeService: writeService as M30WriteRouteService,
    resolveScope: async (actor) => {
      cap.resolvedFor.push(actor);
      return scope;
    },
  });
  return { app, cap };
}

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

const CASELOAD: QualityPatientScope = { kind: "caseload", patientIds: [P_IN] };

describe("GAP-091 — PHI list routes hand the service the server-derived scope", () => {
  it.each([
    "/api/v1/quality/incidents",
    "/api/v1/quality/mortality",
    "/api/v1/quality/infection/events",
  ])("%s resolves scope from the session actor, not from the query string", async (url) => {
    const { app, cap } = makeServer(CASELOAD);
    // A hostile query tries to claim an org-wide scope / roles: it is an unknown param, never an input.
    const res = await app.inject({
      method: "GET",
      url: `${url}?scope=org&roles=medical_director`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(cap.listScopes).toEqual([CASELOAD]);
    expect(cap.resolvedFor[0]).toMatchObject({
      organizationId: ORG,
      userId: "nurse_1",
      roles: ["rn_case_manager"],
    });
    await app.close();
  });

  it("forwards the keyset cursor and page size to the service (no fixed window in the route)", async () => {
    const { app, cap } = makeServer(CASELOAD);
    const cursor = Buffer.from(JSON.stringify({ createdAt: NOW, id: P_IN })).toString("base64url");
    await app.inject({
      method: "GET",
      url: `/api/v1/quality/incidents?limit=100&cursor=${cursor}`,
      headers: HEADERS,
    });
    expect(cap.listArgs).toEqual([{ cursor, limit: 100 }]);
    await app.close();
  });

  it("incident detail is handed the same scope (404-on-deny lives in the service)", async () => {
    const { app, cap } = makeServer(CASELOAD);
    await app.inject({
      method: "GET",
      url: "/api/v1/quality/incidents/11111111-aaaa-4aaa-8aaa-111111111111",
      headers: HEADERS,
    });
    expect(cap.detailScopes).toEqual([CASELOAD]);
    await app.close();
  });
});

describe("GAP-091 — patient-linked creates are scoped (404, write service never reached)", () => {
  const incident = (patientId: string | undefined, key = "k1") => ({
    method: "POST" as const,
    url: "/api/v1/quality/incidents",
    headers: { ...HEADERS, "idempotency-key": key },
    payload: { kind: "fall", severity: "moderate", occurredAt: NOW, data: {}, patientId },
  });
  const infection = (patientId: string) => ({
    method: "POST" as const,
    url: "/api/v1/quality/infection/events",
    headers: { ...HEADERS, "idempotency-key": "k2" },
    payload: { patientId, pathogen: "norovirus", bodySite: "gi", observedAt: NOW },
  });

  it("incident for a patient outside the scope -> 404", async () => {
    const { app, cap } = makeServer(CASELOAD);
    const res = await app.inject(incident(P_OUT));
    expect(res.statusCode).toBe(404);
    expect(cap.created).toBe(0);
    await app.close();
  });

  it("incident for a caseload patient, or with no patient, proceeds", async () => {
    const { app, cap } = makeServer(CASELOAD);
    expect((await app.inject(incident(P_IN))).statusCode).toBe(201);
    expect((await app.inject(incident(undefined, "k1b"))).statusCode).toBe(201);
    expect(cap.created).toBe(2);
    await app.close();
  });

  it("infection event for a patient outside the scope -> 404; an empty caseload denies everything", async () => {
    const out = makeServer(CASELOAD);
    expect((await out.app.inject(infection(P_OUT))).statusCode).toBe(404);
    expect(out.cap.created).toBe(0);
    await out.app.close();
    const none = makeServer({ kind: "caseload", patientIds: [] });
    expect((await none.app.inject(infection(P_IN))).statusCode).toBe(404);
    await none.app.close();
  });

  it("an org-scoped caller may record for any patient", async () => {
    const { app, cap } = makeServer({ kind: "org" });
    expect((await app.inject(infection(P_OUT))).statusCode).toBe(201);
    expect(cap.created).toBe(1);
    await app.close();
  });
});
