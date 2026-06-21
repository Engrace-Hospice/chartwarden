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
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryEncounterBackend,
  registerEncounterAbacPredicates,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";

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
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
// pre-seeded cosign_pending encounters (uuid-shaped slice ids).
const ENC_BY_LPN = "a0000000-0000-4000-8000-000000000001";
const ENC_BY_RN = "a0000000-0000-4000-8000-000000000002";
const ENC_B = "b0000000-0000-4000-8000-000000000003";

const ALL_AUTHOR = [
  "encounter.read", "encounter.author", "encounter.finalize", "encounter.sign",
  "encounter.cosign", "vitals.author", "mileage.author",
];

const PERMISSION_SEED = [
  { userId: "rn_1", permissions: ALL_AUTHOR },
  { userId: "lpn_cos", permissions: ["encounter.read", "encounter.cosign"] },
  { userId: "viewer_1", permissions: ["encounter.read"] },
];

function makeServer() {
  const backend = createInMemoryEncounterBackend({
    encounters: [
      { id: ENC_BY_LPN, organizationId: ORG, patientId: PATIENT, discipline: "lpn", status: "cosign_pending", authoredByUserId: "lpn_1", cosignature: "routed" },
      { id: ENC_BY_RN, organizationId: ORG, patientId: PATIENT, discipline: "lpn", status: "cosign_pending", authoredByUserId: "rn_1", cosignature: "routed" },
      { id: ENC_B, organizationId: ORG_B, patientId: PATIENT, status: "draft", authoredByUserId: "rn_1" },
    ],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.flatMap((s) =>
      [ORG, ORG_B].map((org) => ({
        orgId: org,
        userId: s.userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  resetAbacRegistry();
  registerAbacRegistry();
  registerEncounterAbacPredicates({ resolver: backend.resolver });

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEncounterRoutes(app, { service: backend.service });
  return { app, backend };
}

const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "rn" };
const VIEWER = { "x-test-user": "viewer_1", "x-test-org": ORG, "x-test-roles": "auditor" };
const LPN_COSIGNER = { "x-test-user": "lpn_cos", "x-test-org": ORG, "x-test-roles": "lpn" };
const freshStepUp = () => new Date().toISOString();

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
    const res = await app.inject({ method: "GET", url: `/api/v1/encounters/${ENC_BY_LPN}`, headers: VIEWER });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(ENC_BY_LPN);
  });

  it("a cross-tenant encounter is a non-leaking 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: `/api/v1/encounters/${ENC_B}`, headers: RN });
    expect(res.statusCode).toBe(404);
  });
});

describe("M8-T09 — finalize → sign happy path (§2.3)", () => {
  it("an RN routine_visit draft finalizes then signs", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: { patientId: PATIENT, admissionId: ADMISSION, encounterType: "routine_visit", discipline: "rn", serviceDate: "2026-06-20" },
    });
    const id = draft.json().id as string;

    const finalize = await app.inject({ method: "POST", url: `/api/v1/encounters/${id}/finalize`, headers: RN, payload: {} });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json().status).toBe("finalized");

    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: RN,
      payload: { stepUpAuthAt: freshStepUp(), attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(200);
    expect(sign.json().status).toBe("signed");
  });

  it("412 STEP_UP_AUTH_REQUIRED when the step-up timestamp is stale", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: { patientId: PATIENT, admissionId: ADMISSION, encounterType: "routine_visit", discipline: "rn", serviceDate: "2026-06-20" },
    });
    const id = draft.json().id as string;
    await app.inject({ method: "POST", url: `/api/v1/encounters/${id}/finalize`, headers: RN, payload: {} });

    const sign = await app.inject({
      method: "POST",
      url: `/api/v1/encounters/${id}/sign`,
      headers: RN,
      payload: { stepUpAuthAt: "2020-01-01T00:00:00.000Z", attestationConfirmed: true },
    });
    expect(sign.statusCode).toBe(412);
    expect(sign.json().error.code).toBe("STEP_UP_AUTH_REQUIRED");
  });
});

describe("M8-T09 — §7.7 optimistic concurrency on selections PATCH", () => {
  it("428 without If-Match; 412 VERSION_MISMATCH on a stale version", async () => {
    const { app } = makeServer();
    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/encounters",
      headers: RN,
      payload: { patientId: PATIENT, admissionId: ADMISSION, encounterType: "routine_visit", discipline: "rn", serviceDate: "2026-06-20" },
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
