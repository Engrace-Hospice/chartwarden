// apps/backend/__tests__/admission-routes.test.ts — M6-T06 route-inventory smoke tests (M6 spec
// §4.1–4.2; the §4.5 permission handshake; §4.6 ABAC; §6.3 reason-derived discharge permission).
//
// Exercises M6's routes through the FULL M1 middleware chain via Fastify `inject`, no live infra:
// buildServer() mounts the host, registerAdmissionRoutes() mounts the §4.1 inventory over the shared
// in-memory admission backend (one dataset backing both the route service and the ABAC resolver). The
// REAL Authorization Contract gates every route on the §4.5 keys; a header-auth shim populates
// request.context. Covers: RBAC gating (200 with key, 403 without), the §4.6 role-gated ABAC
// predicates (f2f attest / discharge cosign / compliance override), the §6.3 reason-derived discharge
// permission, and §6.6 cross-tenant non-leak (404).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";
// GAP-020: the patient-keyed routes bind M7's shared `caseload_or_scope` by name; the fresh per-test
// registry must register it (test-only cross-module import, same as assessment-routes.test.ts). Its
// `patientId` arm only consults `isInCaseload`, never the resolver, so the stub resolver is never called.
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const sessionPatient = request.headers["x-test-session-patient"];
  if (typeof sessionPatient === "string")
    request.context.attributes.sessionPatientId = sessionPatient;
}

// GAP-022 / 42 CFR 418.22 — the F2F attestation narrative must be >= 100 characters.
const LONG_NARRATIVE =
  "Patient was seen face to face by the hospice physician; the clinical findings support a terminal prognosis of six months or less.";

const ORG = "org_a";
const ORG_B = "org_b";
const ADMISSION = "adm_seed";
const ADMISSION_B = "adm_seed_b";
const ADMISSION_OTHER_PATIENT = "adm_seed_other_patient";
const WINDOW_OTHER_PATIENT = "win_seed_other_patient";
const F2F = "f2f_seed";
const DISCHARGE = "dis_seed";
const WINDOW = "cw_seed";
const PATIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROVIDER_ENTITY = "11111111-1111-4111-8111-111111111111";
const OTHER_PROVIDER_ENTITY = "22222222-2222-4222-8222-222222222222";
const LOCATION = "33333333-3333-4333-8333-333333333333";
const OTHER_LOCATION = "44444444-4444-4444-8444-444444444444";
// #50 — the activation-siting fixture: an admission whose elected provider entity has TWO active sites.
const ADMISSION_READY = "adm_ready";
// GAP-024 — child-resource binding fixtures: a period of ADMISSION (patient A) and one of another patient.
const EP_OF_ADMISSION = "dddddddd-0000-4000-8000-000000000001";
const EP_OF_OTHER_PATIENT = "dddddddd-0000-4000-8000-000000000002";
const EP_UNKNOWN = "dddddddd-0000-4000-8000-0000000000ff";
const PE_MANY = "pe_many";
const PE_OTHER = "pe_other";
// Uuid-shaped: the activate body validates `locationId` as a uuid at the route boundary, so a
// slice-style opaque id would be refused as VALIDATION_FAILED before the siting rule ever runs.
const LOC_MAIN = "55555555-0000-4000-8000-000000000001";
const LOC_IPU = "55555555-0000-4000-8000-000000000002";
const LOC_OTHER = "55555555-0000-4000-8000-000000000009";

// Grants: an intake coordinator (referral/admission writes), a clinician (reads + cti/f2f), a
// medical director (discharge/cosign), and a compliance officer (override).
const PERMISSION_SEED = [
  {
    userId: "intake_1",
    permissions: [
      "referral.create",
      "referral.read",
      "admission.create",
      "admission.update",
      "admission.read",
      "discharge.death",
    ],
  },
  {
    userId: "rn_1",
    permissions: [
      "admission.read",
      "cti.read",
      "f2f.read",
      "f2f.attest",
      "f2f.complete",
      "election.read",
      "loc.change",
      "loc.read",
    ],
  },
  {
    userId: "md_1",
    permissions: ["f2f.attest", "discharge.for_cause", "discharge.cosign_for_cause"],
  },
  {
    userId: "md_2",
    permissions: ["f2f.attest", "discharge.for_cause", "discharge.cosign_for_cause"],
  },
  // GAP-121 — a clinician (no org-wide / unsited-admission escape) who may record a death discharge.
  { userId: "dis_rn", permissions: ["discharge.death"] },
  { userId: "co_1", permissions: ["compliance.read", "compliance.override"] },
  // A clinician who may read the org compliance-window list (narrowed to their caseload).
  { userId: "rn_cw", permissions: ["compliance.read"] },
  // GAP-022 — a scheduler (intake side): may schedule an F2F but is not the performer.
  { userId: "sched_1", permissions: ["f2f.schedule", "admission.read"] },
  // GAP-024 — an election drafter.
  { userId: "ed_1", permissions: ["election.draft", "admission.read"] },
  // Bug 4 — an intake user who may record a transfer-in.
  { userId: "xfer_1", permissions: ["transfer.in", "admission.read"] },
  // #50 — an intake user who may activate, for the service-location siting tests below.
  { userId: "act_1", permissions: ["admission.read", "admission.activate"] },
];

function makeServer(
  options: {
    isInCaseload?: (q: {
      organizationId: string;
      userId: string;
      patientId: string;
    }) => Promise<boolean>;
    caseloadPatientIds?: (q: { organizationId: string; userId: string }) => Promise<string[]>;
    /** GAP-022 — the role keys each scheduled clinician actually holds (the M3 grants stand-in). */
    clinicianRoleKeys?: Readonly<Record<string, readonly string[]>>;
  } = {},
) {
  const backend = createInMemoryAdmissionBackend({
    clinicianRoleKeys: options.clinicianRoleKeys,
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "active",
        patientId: PATIENT_A,
      },
      {
        id: ADMISSION_OTHER_PATIENT,
        organizationId: ORG,
        kind: "admission",
        state: "active",
        patientId: PATIENT_B,
      },
      {
        id: ADMISSION_B,
        organizationId: ORG_B,
        kind: "admission",
        state: "active",
        patientId: PATIENT_B,
      },
      {
        id: F2F,
        organizationId: ORG,
        kind: "f2f",
        state: "completed",
        admissionId: ADMISSION,
        scheduledClinicianId: "rn_1",
      },
      {
        id: DISCHARGE,
        organizationId: ORG,
        kind: "discharge",
        state: "awaiting_cosign",
        admissionId: ADMISSION,
        patientId: PATIENT_A,
      },
      {
        id: WINDOW,
        organizationId: ORG,
        kind: "compliance_window",
        state: "open",
        admissionId: ADMISSION,
        patientId: PATIENT_A,
      },
      {
        id: WINDOW_OTHER_PATIENT,
        organizationId: ORG,
        kind: "compliance_window",
        state: "overdue",
        admissionId: ADMISSION_OTHER_PATIENT,
        patientId: PATIENT_B,
      },
      {
        id: LOCATION,
        organizationId: ORG,
        kind: "location",
        providerEntityId: PROVIDER_ENTITY,
      },
      {
        id: OTHER_LOCATION,
        organizationId: ORG,
        kind: "location",
        providerEntityId: OTHER_PROVIDER_ENTITY,
      },
      // #50 — a gate-ready admission under a MULTI-location provider entity. The readiness gate requires
      // a location before activation, so it is already sited (as `updateAdmission` would have done).
      {
        id: ADMISSION_READY,
        organizationId: ORG,
        kind: "admission",
        state: "notice_of_rights_acknowledged",
        patientId: "pat_ready",
        admissionAt: "2026-06-02T00:00:00Z",
        providerEntityId: PE_MANY,
        locationId: LOC_MAIN,
      },
      {
        id: EP_OF_ADMISSION,
        organizationId: ORG,
        kind: "election_period",
        state: "active",
        admissionId: ADMISSION,
        sequence: 1,
      },
      {
        id: EP_OF_OTHER_PATIENT,
        organizationId: ORG,
        kind: "election_period",
        state: "active",
        admissionId: ADMISSION_OTHER_PATIENT,
        sequence: 1,
      },
      {
        id: "ep_ready",
        organizationId: ORG,
        kind: "election_period",
        state: "active",
        admissionId: ADMISSION_READY,
        sequence: 1,
      },
      {
        id: "es_ready",
        organizationId: ORG,
        kind: "election_statement",
        state: "signed",
        admissionId: ADMISSION_READY,
        electionPeriodId: "ep_ready",
      },
      {
        id: "nor_ready",
        organizationId: ORG,
        kind: "nor",
        state: "acknowledged",
        admissionId: ADMISSION_READY,
        acknowledgedByRole: "patient",
        deliveryMethod: "electronic_witnessed",
      },
      {
        id: "cti_ready",
        organizationId: ORG,
        kind: "cti",
        state: "signed",
        admissionId: ADMISSION_READY,
        electionPeriodId: "ep_ready",
      },
    ],
    // #50 — the M1 location directory the Drizzle backend reads through an injected port.
    providerEntityLocations: { [PE_MANY]: [LOC_MAIN, LOC_IPU], [PE_OTHER]: [LOC_OTHER] },
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.flatMap((s) =>
      [ORG, ORG_B].map((org) => ({
        orgId: org,
        userId: s.userId,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: s.permissions,
          },
        ],
      })),
    ),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // A FRESH registry per server (not the shared module-level `abacRegistry`): the shared registry's
  // `registerIdempotent` treats same-SOURCE closures as a "reboot" no-op (comparing `Function.
  // prototype.toString()`, which is identical across calls since it's the same factory literal) — so
  // reusing it across tests would silently keep test 1's `backend.resolver` bound forever, resolving
  // every later test's scope predicates against test 1's (stale, disconnected) in-memory dataset
  // instead of the fresh one just built above (the field-safety-routes.test.ts precedent).
  const registry = createPredicateRegistry();
  const predicates = buildAdmissionAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: options.isInCaseload ?? (async () => true),
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  const m7Predicates = buildCarePlanAbacPredicates({
    resolver: {
      loadPlan: async () => null,
      loadProblem: async () => null,
      loadVersion: async () => null,
    },
    isInCaseload: options.isInCaseload ?? (async () => true),
  });
  registry.register("caseload_or_scope", m7Predicates.caseload_or_scope);
  registerAbacRegistry(registry);

  const app = buildServer({
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerAdmissionRoutes(app, {
    service: backend.service,
    caseloadPatientIds: options.caseloadPatientIds ?? (async () => [PATIENT_A, PATIENT_B]),
  });
  return { app, backend };
}

const INTAKE = {
  "x-test-user": "intake_1",
  "x-test-org": ORG,
  "x-test-roles": "intake_coordinator",
};
const RN = {
  "x-test-user": "rn_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_rn",
};
const RN_AS_NP = {
  "x-test-user": "rn_1",
  "x-test-org": ORG,
  "x-test-roles": "np",
};
const MD = {
  "x-test-user": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "medical_director",
};
const MD_2 = {
  "x-test-user": "md_2",
  "x-test-org": ORG,
  "x-test-roles": "medical_director",
};
const MD_NO_ROLE = {
  "x-test-user": "md_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_admin",
};
const CO = {
  "x-test-user": "co_1",
  "x-test-org": ORG,
  "x-test-roles": "compliance_officer",
};
const CO_NO_ROLE = {
  "x-test-user": "co_1",
  "x-test-org": ORG,
  "x-test-roles": "clinical_admin",
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M6-T06 — admission routes (§4.1–4.2, §4.5 gating)", () => {
  it("POST /referrals creates for an intake coordinator (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: INTAKE,
      payload: {
        source: "phone",
        receivedAt: "2026-06-20T10:00:00Z",
        receivingUserId: "11111111-1111-1111-1111-111111111111",
        patientNameAtReceipt: "Jane Roe",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe("received");
    await app.close();
  });

  it("POST /referrals can pre-link a known patient for patient-scoped admission creation", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: INTAKE,
      payload: {
        source: "phone",
        receivedAt: "2026-06-20T10:00:00Z",
        patientId: PATIENT_A,
        patientNameAtReceipt: "Ava Stone",
      },
    });
    expect(created.statusCode).toBe(201);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/referrals/${created.json().id}`,
      headers: INTAKE,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      patientId: PATIENT_A,
      patientResolutionStatus: "matched",
    });
    await app.close();
  });

  it("denies referral.create without the key (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/referrals",
      headers: RN, // rn_1 lacks referral.create
      payload: {
        source: "phone",
        receivedAt: "2026-06-20T10:00:00Z",
        receivingUserId: "11111111-1111-1111-1111-111111111111",
        patientNameAtReceipt: "Jane Roe",
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("requires a session (401) when unauthenticated", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /admissions/:id resolves a seeded admission for a reader (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(ADMISSION);
    await app.close();
  });

  it("GET /admissions filters active admissions by patientId without changing the org list default", async () => {
    const { app } = makeServer();
    const unscoped = await app.inject({
      method: "GET",
      url: "/api/v1/admissions?state=active",
      headers: RN,
    });
    expect(unscoped.statusCode).toBe(200);
    expect(unscoped.json().items.map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining([ADMISSION, ADMISSION_OTHER_PATIENT]),
    );

    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/admissions?state=active&patientId=${PATIENT_A}`,
      headers: RN,
    });
    expect(scoped.statusCode).toBe(200);
    const ids = scoped.json().items.map((i: { id: string }) => i.id);
    expect(ids).toContain(ADMISSION);
    expect(ids).not.toContain(ADMISSION_OTHER_PATIENT);
    await app.close();
  });

  it("GET /patients/:patientId/election-certification assembles the aggregate for a reader (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT_A}/election-certification`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.admission?.id).toBe(ADMISSION);
    expect(Array.isArray(body.periods)).toBe(true);
    // The seeded admission has an open compliance window → it surfaces on the aggregate.
    expect(body.complianceWindows.some((w: { id: string }) => w.id === WINDOW)).toBe(true);
    await app.close();
  });

  it("GET /patients/:patientId/admissions resolves the admission every clinical create is keyed by (F-065)", async () => {
    // Nothing could answer "which admission am I documenting against" for a patient: the org-wide
    // census takes no patient filter and its items carry `{ id, state, version }` with no `patientId`,
    // and the patient read carries no admission. So `POST /medication-orders`, `POST /encounters` and
    // `POST /care-plans` — all keyed by `admissionId` — had no way to obtain one for a first record.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT_A}/admissions`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((a: { id: string }) => a.id)).toContain(ADMISSION);
  });

  it("a patient with no admissions gets an EMPTY list, not a 404 (F-065)", async () => {
    // An empty list is the truthful answer; a 404 would leak whether the patient exists at all.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients/00000000-0000-4000-8000-000000000000/admissions",
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it("denies /patients/:patientId/admissions without admission.read (403)", async () => {
    // `CO` (compliance officer) is the seeded actor with no `admission.read` — INTAKE holds it, which
    // is correct: an intake coordinator reads admissions by definition.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT_A}/admissions`,
      headers: CO,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  describe("GAP-020 — GET /admissions narrows the org list to the caller's caseload", () => {
    const idsOf = (res: { json: () => { items: { id: string }[] } }) =>
      res.json().items.map((i) => i.id);
    const list = async (
      headers: Record<string, string>,
      caseloadPatientIds: () => Promise<string[]>,
      url = "/api/v1/admissions",
    ) => {
      const { app } = makeServer({ caseloadPatientIds });
      const res = await app.inject({ method: "GET", url, headers });
      await app.close();
      return res;
    };

    it("returns only the caseload patient's admissions to a scoped clinician", async () => {
      const res = await list(RN, async () => [PATIENT_A]);
      expect(res.statusCode).toBe(200);
      const ids = idsOf(res);
      expect(ids).toContain(ADMISSION);
      expect(ids).not.toContain(ADMISSION_OTHER_PATIENT);
    });

    it("returns an empty list for an empty caseload", async () => {
      const res = await list(RN, async () => []);
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
    });

    it("fails closed (empty list) when the caseload cannot be resolved", async () => {
      const res = await list(RN, async () => {
        throw new Error("seam down");
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
    });

    it("lets an org-wide oversight role see every admission without a caseload lookup", async () => {
      const lookup = vi.fn(async () => [] as string[]);
      const res = await list({ ...RN, "x-test-roles": "medical_director" }, lookup);
      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual(expect.arrayContaining([ADMISSION, ADMISSION_OTHER_PATIENT]));
      expect(lookup).not.toHaveBeenCalled();
    });

    it("a session pinned to a patient sees that patient's admissions", async () => {
      const res = await list({ ...RN, "x-test-session-patient": PATIENT_B }, async () => []);
      expect(res.statusCode).toBe(200);
      const ids = idsOf(res);
      expect(ids).toContain(ADMISSION_OTHER_PATIENT);
      expect(ids).not.toContain(ADMISSION);
    });
  });

  describe("GET /compliance-windows narrows the org list to the caller's caseload", () => {
    const RN_CW = { ...RN, "x-test-user": "rn_cw" };
    const idsOf = (res: { json: () => { items: { id: string }[] } }) =>
      res.json().items.map((i) => i.id);
    const list = async (
      headers: Record<string, string>,
      caseloadPatientIds: () => Promise<string[]>,
      url = "/api/v1/compliance-windows",
    ) => {
      const { app } = makeServer({ caseloadPatientIds });
      const res = await app.inject({ method: "GET", url, headers });
      await app.close();
      return res;
    };

    it("returns only the caseload patient's windows, each carrying its patientId", async () => {
      const res = await list(RN_CW, async () => [PATIENT_B]);
      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual([WINDOW_OTHER_PATIENT]);
      expect(res.json().items[0].patientId).toBe(PATIENT_B);
    });

    it("returns an empty list for an empty caseload and fails closed when the seam is down", async () => {
      expect((await list(RN_CW, async () => [])).json().items).toEqual([]);
      const down = await list(RN_CW, async () => {
        throw new Error("seam down");
      });
      expect(down.statusCode).toBe(200);
      expect(down.json().items).toEqual([]);
    });

    it("lets compliance_officer see every window without a caseload lookup", async () => {
      const lookup = vi.fn(async () => [] as string[]);
      const res = await list(CO, lookup);
      expect(idsOf(res)).toEqual(expect.arrayContaining([WINDOW, WINDOW_OTHER_PATIENT]));
      expect(lookup).not.toHaveBeenCalled();
    });

    it("still applies the state filter inside the caseload", async () => {
      const res = await list(
        RN_CW,
        async () => [PATIENT_A, PATIENT_B],
        "/api/v1/compliance-windows?state=overdue",
      );
      expect(idsOf(res)).toEqual([WINDOW_OTHER_PATIENT]);
    });
  });

  describe("GAP-020 — patient-keyed routes carry caseload scope (404 on a miss, never 403)", () => {
    const outOfCaseload = { isInCaseload: async () => false };
    const createBody = {
      patientId: PATIENT_A,
      intakeMethod: "phone",
      hospiceMedicalDirectorId: PROVIDER_ENTITY,
    };

    it("GET /patients/:patientId/admissions is 404 for a clinician outside the caseload", async () => {
      const { app } = makeServer(outOfCaseload);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PATIENT_A}/admissions`,
        headers: RN,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("GET /patients/:patientId/election-certification is 404 for a clinician outside the caseload", async () => {
      const { app } = makeServer(outOfCaseload);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PATIENT_A}/election-certification`,
        headers: RN,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("POST /admissions is 404 when body.patientId is outside the caller's caseload", async () => {
      const { app } = makeServer(outOfCaseload);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admissions",
        headers: INTAKE,
        payload: createBody,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("an in-caseload clinician still reads both patient-keyed GETs (200)", async () => {
      const { app } = makeServer({ isInCaseload: async (q) => q.patientId === PATIENT_A });
      const a = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PATIENT_A}/admissions`,
        headers: RN,
      });
      const e = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PATIENT_A}/election-certification`,
        headers: RN,
      });
      expect(a.statusCode).toBe(200);
      expect(e.statusCode).toBe(200);
      await app.close();
    });

    it("an in-caseload intake user can POST /admissions (scope passes; not a 404)", async () => {
      const { app } = makeServer({ isInCaseload: async (q) => q.patientId === PATIENT_A });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admissions",
        headers: INTAKE,
        payload: createBody,
      });
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).not.toBe(403);
      await app.close();
    });

    it("an org-wide oversight role passes the scope gate with no caseload row", async () => {
      const { app } = makeServer(outOfCaseload);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PATIENT_A}/admissions`,
        headers: { ...RN, "x-test-roles": "medical_director" },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  it("denies /patients/:patientId/election-certification without election.read (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT_A}/election-certification`,
      headers: INTAKE,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("§6.6 cross-tenant non-leak — an org_a actor cannot read an org_b admission (404)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION_B}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GAP-011 §4.6 admission.scope — a same-org clinician OUTSIDE the patient's caseload cannot read the admission (404, not 403 — §6.6 existence non-leak: same signal as an absent/cross-tenant id)", async () => {
    // A clinician with `admission.read` granted, no `medical_director`/matching-providerEntity role,
    // and NOT on the patient's caseload: exactly the scenario the report's own recommended
    // verification names (a non-caseload clinician on GET /api/v1/admissions/:id).
    const { app } = makeServer({ isInCaseload: async () => false });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("allows intake staff to open a freshly converted unsited admission even before caseload/provider siting", async () => {
    const { app } = makeServer({ isInCaseload: async () => false });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("PATCH /admissions/:id persists providerEntityId and locationId", async () => {
    const { app } = makeServer();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
      payload: {
        ifVersion: 1,
        admissionAt: "2026-06-20T00:00:00.000Z",
        providerEntityId: PROVIDER_ENTITY,
        locationId: LOCATION,
      },
    });
    expect(updated.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      providerEntityId: PROVIDER_ENTITY,
      locationId: LOCATION,
    });
    await app.close();
  });

  it("PATCH /admissions/:id records the UB-04 Type of Admission and Point of Origin the hospice claim carries, and null clears one", async () => {
    const { app } = makeServer();
    const patch = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/admissions/${ADMISSION}`,
        headers: INTAKE,
        payload,
      });
    const detail = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/admissions/${ADMISSION}`,
          headers: INTAKE,
        })
      ).json();

    // Unrecorded on a fresh (and any historical) admission: null, never an invented code.
    expect(await detail()).toMatchObject({ admissionTypeCode: null, admissionSourceCode: null });

    expect(
      (await patch({ ifVersion: 1, admissionTypeCode: "3", admissionSourceCode: "1" })).statusCode,
    ).toBe(200);
    expect(await detail()).toMatchObject({ admissionTypeCode: "3", admissionSourceCode: "1" });

    // null clears a mis-recorded value; an omitted field leaves it.
    const cleared = await patch({ ifVersion: 2, admissionSourceCode: null });
    expect(cleared.statusCode).toBe(200);
    expect(await detail()).toMatchObject({ admissionTypeCode: "3", admissionSourceCode: null });
    await app.close();
  });

  it.each([
    ["an unknown type of admission", { admissionTypeCode: "4" }],
    ["an unknown point of origin", { admissionSourceCode: "7" }],
    ["a non-code value", { admissionTypeCode: "elective" }],
  ])("PATCH /admissions/:id rejects %s (422) before any write", async (_name, over) => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
      payload: { ifVersion: 1, ...over },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("PATCH /admissions/:id derives the provider location when the UI saves admission details", async () => {
    const { app } = makeServer();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
      payload: {
        ifVersion: 1,
        admissionAt: "2026-06-20T00:00:00.000Z",
        providerEntityId: PROVIDER_ENTITY,
      },
    });
    expect(updated.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      providerEntityId: PROVIDER_ENTITY,
      locationId: LOCATION,
    });
    await app.close();
  });

  it("PATCH /admissions/:id rejects a location from another provider entity", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: INTAKE,
      payload: {
        ifVersion: 1,
        providerEntityId: PROVIDER_ENTITY,
        locationId: OTHER_LOCATION,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("LOCATION_PROVIDER_MISMATCH");
    await app.close();
  });

  it("GAP-011 §4.6 admission.scope — the SAME clinician CAN read once caseload membership resolves true", async () => {
    const { app } = makeServer({ isInCaseload: async () => true });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${ADMISSION}`,
      headers: RN,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("§4.6 f2f attest — ABAC role predicate denies a non-MD/NP clinician (403) but allows an NP (200)", async () => {
    const { app } = makeServer();
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/attest`,
      headers: RN, // has f2f.attest perm but role is clinical_rn → fails f2f.is_hospice_md_or_np
      payload: {
        attestationNarrative: LONG_NARRATIVE,
        ifVersion: 1,
      },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/attest`,
      headers: RN_AS_NP,
      payload: {
        attestationNarrative: LONG_NARRATIVE,
        ifVersion: 1,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe("attested");
    await app.close();
  });

  it("GAP-022 f2f attest — a 20-char narrative is refused 422 F2F_ATTESTATION_TOO_SHORT and the service never attests", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/attest`,
      headers: RN_AS_NP,
      payload: { attestationNarrative: "x".repeat(20), ifVersion: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("F2F_ATTESTATION_TOO_SHORT");
    expect(backend.events).not.toContain("m6.f2f.attested");
    await app.close();
  });

  it("GAP-022 f2f attest — the route forwards the narrative to the service (it used to be parsed and dropped)", async () => {
    const { app, backend } = makeServer();
    const seen: unknown[][] = [];
    const real = backend.service.attestF2f.bind(backend.service);
    backend.service.attestF2f = async (...args: Parameters<typeof real>) => {
      seen.push(args);
      return real(...args);
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/attest`,
      headers: RN_AS_NP,
      payload: { attestationNarrative: LONG_NARRATIVE, ifVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(LONG_NARRATIVE);
    await app.close();
  });

  it.each(["rn", "rn_case_manager"])(
    "GAP-022 f2f attest — an %s-only caller is denied 403 (the MD/NP predicate no longer admits RNs)",
    async (role) => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/face-to-face/${F2F}/attest`,
        headers: { ...RN, "x-test-roles": role },
        payload: { attestationNarrative: LONG_NARRATIVE, ifVersion: 1 },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    },
  );

  it.each(["md", "np", "hospice_physician", "medical_director"])(
    "GAP-022 f2f attest — a %s caller passes the MD/NP predicate",
    async (role) => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/face-to-face/${F2F}/attest`,
        headers: { ...RN, "x-test-roles": role },
        payload: { attestationNarrative: LONG_NARRATIVE, ifVersion: 1 },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    },
  );

  describe("GAP-022 f2f schedule — the performer role comes from the clinician's grants, not the body", () => {
    const CLINICIAN_RN = "cccccccc-0000-4000-8000-000000000001";
    const CLINICIAN_NP = "cccccccc-0000-4000-8000-000000000002";
    const SCHED = {
      "x-test-user": "sched_1",
      "x-test-org": ORG,
      "x-test-roles": "intake_coordinator",
    };
    const body = (scheduledClinicianId: string, clinicianRole: string) => ({
      electionPeriodId: EP_OF_ADMISSION,
      scheduledDate: "2026-06-25",
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
      clinicianRole,
      scheduledClinicianId,
    });
    const roles = { [CLINICIAN_RN]: ["rn", "rn_case_manager"], [CLINICIAN_NP]: ["np"] };

    it("an RN clinician claimed as hospice_md is refused 422 F2F_INVALID_PERFORMER", async () => {
      const { app } = makeServer({ clinicianRoleKeys: roles });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
        headers: SCHED,
        payload: body(CLINICIAN_RN, "hospice_md"),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("F2F_INVALID_PERFORMER");
      await app.close();
    });

    it("an NP clinician claimed as hospice_md is refused (a role the clinician does not hold)", async () => {
      const { app } = makeServer({ clinicianRoleKeys: roles });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
        headers: SCHED,
        payload: body(CLINICIAN_NP, "hospice_md"),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("F2F_INVALID_PERFORMER");
      await app.close();
    });

    it("an unknown clinician (no grants on file) is refused", async () => {
      const { app } = makeServer({ clinicianRoleKeys: roles });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
        headers: SCHED,
        payload: body("cccccccc-0000-4000-8000-0000000000ff", "hospice_np"),
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("an NP clinician claimed as hospice_np schedules (201)", async () => {
      const { app } = makeServer({ clinicianRoleKeys: roles });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
        headers: SCHED,
        payload: body(CLINICIAN_NP, "hospice_np"),
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  describe("GAP-024 child-resource binding — the election period must belong to the admission in the path", () => {
    const CLINICIAN_NP = "cccccccc-0000-4000-8000-000000000002";
    const SCHED = {
      "x-test-user": "sched_1",
      "x-test-org": ORG,
      "x-test-roles": "intake_coordinator",
    };
    const DRAFTER = {
      "x-test-user": "ed_1",
      "x-test-org": ORG,
      "x-test-roles": "intake_coordinator",
    };
    const f2fBody = (electionPeriodId: string) => ({
      electionPeriodId,
      scheduledDate: "2026-06-25",
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
      clinicianRole: "hospice_np",
      scheduledClinicianId: CLINICIAN_NP,
    });
    const esBody = (electionPeriodId: string) => ({
      electionPeriodId,
      effectiveDate: "2026-06-01",
      primaryDiagnosisIcd10: "C34.90",
      electedProviderEntityId: PROVIDER_ENTITY,
      waiverAcknowledged: true,
    });
    const roles = { [CLINICIAN_NP]: ["np"] };

    it.each([
      ["another admission's period", EP_OF_OTHER_PATIENT],
      ["an unknown period", EP_UNKNOWN],
    ])("f2f schedule against %s is 404 and nothing is written", async (_l, ep) => {
      const { app, backend } = makeServer({ clinicianRoleKeys: roles });
      const before = backend.events.length;
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
        headers: SCHED,
        payload: f2fBody(ep),
      });
      expect(res.statusCode).toBe(404);
      expect(backend.events.length).toBe(before);
      await app.close();
    });

    it("f2f schedule against the admission's own period schedules (201)", async () => {
      const { app } = makeServer({ clinicianRoleKeys: roles });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/face-to-face`,
        headers: SCHED,
        payload: f2fBody(EP_OF_ADMISSION),
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it.each([
      ["another admission's period", EP_OF_OTHER_PATIENT],
      ["an unknown period", EP_UNKNOWN],
    ])("election-statement draft against %s is 404", async (_l, ep) => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/election-statements`,
        headers: DRAFTER,
        payload: esBody(ep),
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("election-statement draft against the admission's own period passes the binding", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/election-statements`,
        headers: DRAFTER,
        payload: esBody(EP_OF_ADMISSION),
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  it("F-226 f2f complete — the route forwards the body's encounterDate to the service (it used to be dropped)", async () => {
    const { app, backend } = makeServer();
    const seen: unknown[][] = [];
    const real = backend.service.completeF2f.bind(backend.service);
    backend.service.completeF2f = async (...args: Parameters<typeof real>) => {
      seen.push(args);
      return real(...args);
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/complete`,
      headers: RN_AS_NP,
      payload: { encounterDate: "2026-06-15", encounterLocation: "patient_home", ifVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[3]).toBe("2026-06-15");
    // FY2027 R-F2F-05 — the modality is forwarded too, and is REQUIRED on the route.
    expect(seen[0]?.[4]).toEqual({
      encounterLocation: "patient_home",
      telehealthEligibility: null,
    });
    const noModality = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/complete`,
      headers: RN_AS_NP,
      payload: { encounterDate: "2026-06-15", ifVersion: 1 },
    });
    expect(noModality.statusCode).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(1);
    // a malformed date never reaches the service
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/complete`,
      headers: RN_AS_NP,
      payload: { encounterDate: "not-a-date", encounterLocation: "patient_home", ifVersion: 1 },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(1);
    await app.close();
  });

  it("§6.3 discharge — the permission key is derived from reason server-side", async () => {
    const { app } = makeServer();
    // intake_1 has discharge.death but NOT discharge.for_cause.
    const forCause = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/discharge`,
      headers: INTAKE,
      payload: {
        reason: "for_cause",
        dischargeDate: "2026-06-20",
        narrative: " x".repeat(30),
        forCauseReason: "y".repeat(30),
      },
    });
    expect(forCause.statusCode).toBe(403);

    const death = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/discharge`,
      headers: INTAKE,
      payload: {
        reason: "death",
        dischargeDate: "2026-06-20",
        narrative: "patient expired at home",
        deathCertifierId: "55555555-5555-4555-8555-555555555555",
        placeOfDeath: "home",
      },
    });
    expect(death.statusCode).toBe(201);
    expect(death.json().requiresMedicalDirectorCosign).toBe(false);
    await app.close();
  });

  it("§4.6 discharge cosign — ABAC requires medical_director role (403 without, 200 with)", async () => {
    const denied = await makeServer();
    const noRole = await denied.app.inject({
      method: "POST",
      url: `/api/v1/discharges/${DISCHARGE}/cosign-for-cause`,
      headers: MD_NO_ROLE,
      payload: {
        cosignerName: "Dr. House",
        cosignerNpi: "1234567893",
        ifVersion: 1,
      },
    });
    expect(noRole.statusCode).toBe(403);
    await denied.app.close();

    const allowed = makeServer();
    const ok = await allowed.app.inject({
      method: "POST",
      url: `/api/v1/discharges/${DISCHARGE}/cosign-for-cause`,
      headers: MD,
      payload: {
        cosignerName: "Dr. House",
        cosignerNpi: "1234567893",
        ifVersion: 1,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe("completed");
    await allowed.app.close();
  });

  describe("GAP-121 for-cause discharge governance", () => {
    const fileForCause = (app: ReturnType<typeof makeServer>["app"], headers: typeof MD) =>
      app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/discharge`,
        headers,
        payload: {
          reason: "for_cause",
          dischargeDate: "2026-06-20",
          narrative: " x".repeat(30),
          forCauseReason: "y".repeat(30),
        },
      });
    const cosignBody = { cosignerName: "Dr. House", cosignerNpi: "1234567893", ifVersion: 1 };

    it("the filer cannot cosign their own for-cause discharge (409), a different director can", async () => {
      const { app } = makeServer();
      const filed = await fileForCause(app, MD);
      expect(filed.statusCode).toBe(201);
      const id = filed.json().id;
      const url = `/api/v1/discharges/${id}/cosign-for-cause`;

      const self = await app.inject({ method: "POST", url, headers: MD, payload: cosignBody });
      expect(self.statusCode).toBe(409);
      expect(self.json().error.code).toBe("DISCHARGE_COSIGNER_IS_FILER");

      const other = await app.inject({ method: "POST", url, headers: MD_2, payload: cosignBody });
      expect(other.statusCode).toBe(200);
      expect(other.json().state).toBe("completed");
      await app.close();
    });

    it("a director can decline: the discharge is voided and the admission stays active", async () => {
      const { app } = makeServer();
      const filed = await fileForCause(app, MD);
      const id = filed.json().id;
      const declined = await app.inject({
        method: "POST",
        url: `/api/v1/discharges/${id}/decline-for-cause`,
        headers: MD_2,
        payload: { declineReason: "Insufficient documentation of cause", ifVersion: 1 },
      });
      expect(declined.statusCode).toBe(200);
      expect(declined.json().state).toBe("voided");
      // a voided discharge cannot then be cosigned or declined again
      const again = await app.inject({
        method: "POST",
        url: `/api/v1/discharges/${id}/decline-for-cause`,
        headers: MD_2,
        payload: { declineReason: "Insufficient documentation of cause", ifVersion: 2 },
      });
      expect(again.statusCode).toBe(409);
      await app.close();
    });

    it("decline needs discharge.cosign_for_cause (403 without)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/discharges/${DISCHARGE}/decline-for-cause`,
        headers: MD_NO_ROLE,
        payload: { declineReason: "Insufficient documentation of cause", ifVersion: 1 },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("discharge is chart-scoped: a clinician outside the caseload gets 404", async () => {
      const { app } = makeServer({ isInCaseload: async () => false });
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/discharge`,
        headers: { "x-test-user": "dis_rn", "x-test-org": ORG, "x-test-roles": "clinical_rn" },
        payload: {
          reason: "death",
          dischargeDate: "2026-06-20",
          narrative: "patient expired at home",
          deathCertifierId: "55555555-5555-4555-8555-555555555555",
          placeOfDeath: "home",
        },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  it("§4.6 compliance override — ABAC requires compliance_officer role (403 without, 200 with)", async () => {
    const a = makeServer();
    const noRole = await a.app.inject({
      method: "POST",
      url: `/api/v1/compliance-windows/${WINDOW}/override`,
      headers: CO_NO_ROLE,
      payload: { reason: "documented exception approved by QA", ifVersion: 1 },
    });
    expect(noRole.statusCode).toBe(403);
    await a.app.close();

    const b = makeServer();
    const ok = await b.app.inject({
      method: "POST",
      url: `/api/v1/compliance-windows/${WINDOW}/override`,
      headers: CO,
      payload: { reason: "documented exception approved by QA", ifVersion: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe("closed");
    await b.app.close();
  });

  // Confirm-handshake fix (2026-08-05): LocChangeSchema used to accept short codes (rhc/crc/gip/iri)
  // that never matched what changeLoc actually validated against (routine_home_care etc.) — every real
  // call 422'd regardless of level. These prove the REAL route now works end-to-end through Fastify
  // inject, not just that the service method compiles.
  it("POST /admissions/:id/level-of-care (routine_home_care) succeeds through the real route (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/level-of-care`,
      headers: RN,
      payload: {
        newLevel: "routine_home_care",
        effectiveStart: "2026-06-20",
        reason: "routine home care ordered",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ state: string }>().state).toBe("active");
    await app.close();
  });

  it("denies loc.change without the key (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/level-of-care`,
      headers: INTAKE, // intake_1 lacks loc.change
      payload: {
        newLevel: "routine_home_care",
        effectiveStart: "2026-06-20",
        reason: "routine home care ordered",
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST /level-of-care (general_inpatient_care) without facilityId → 422 IPU_FACILITY_REQUIRED", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/level-of-care`,
      headers: RN,
      payload: {
        newLevel: "general_inpatient_care",
        effectiveStart: "2026-06-20",
        reason: "uncontrolled symptoms requiring inpatient management now",
        gipAttestations: {
          symptomsNotManageableElsewhere: true,
          intensityWarrantsGip: true,
          inpatientSettingIdentified: true,
        },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("IPU_FACILITY_REQUIRED");
    await app.close();
  });

  it("GIP with a facilityId lands in 'assigning', then confirm-bed activates it (201 → 200)", async () => {
    const { app } = makeServer();
    const assigning = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/level-of-care`,
      headers: RN,
      payload: {
        newLevel: "general_inpatient_care",
        effectiveStart: "2026-06-20",
        reason: "uncontrolled symptoms requiring inpatient management now",
        facilityId: "99999999-9999-4999-8999-999999999999",
        gipAttestations: {
          symptomsNotManageableElsewhere: true,
          intensityWarrantsGip: true,
          inpatientSettingIdentified: true,
        },
      },
    });
    expect(assigning.statusCode).toBe(201);
    const assigningBody = assigning.json();
    expect(assigningBody.state).toBe("assigning");

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/level-of-care/${assigningBody.id}/confirm-bed`,
      headers: RN,
      payload: { ifVersion: assigningBody.version },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().state).toBe("active");
    await app.close();
  });

  // GAP-122 / D12 — the three attestations are enforced server-side (412), on top of R-LCP-01's reason floor.
  it.each([
    ["none supplied", undefined],
    [
      "one unchecked",
      {
        symptomsNotManageableElsewhere: true,
        intensityWarrantsGip: false,
        inpatientSettingIdentified: true,
      },
    ],
  ])(
    "GIP without all three D12 attestations (%s) -> 412 GIP_DOCUMENTATION_INCOMPLETE",
    async (_label, attestations) => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/level-of-care`,
        headers: RN,
        payload: {
          newLevel: "general_inpatient_care",
          effectiveStart: "2026-06-20",
          reason: "uncontrolled symptoms requiring inpatient management now",
          facilityId: "99999999-9999-4999-8999-999999999999",
          ...(attestations ? { gipAttestations: attestations } : {}),
        },
      });
      expect(res.statusCode).toBe(412);
      expect(res.json().error.code).toBe("GIP_DOCUMENTATION_INCOMPLETE");
      await app.close();
    },
  );

  it("a non-GIP level change needs no attestations", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/level-of-care`,
      headers: RN,
      payload: {
        newLevel: "continuous_home_care",
        effectiveStart: "2026-06-20",
        reason: "crisis symptoms needing continuous nursing at home",
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

// ── #50 — activation sites the admission at a service location ─────────────────────────────────────
//
// `admission.location_id` was never written by any code path, so every admission was unsited and M10
// refused to create its HOPE timepoint windows (`hope_timepoint_schedule.location_id` is NOT NULL).
// These assert the HTTP surface: the route carries `locationId` through and renders each refusal.
describe("M6 — #50 the activation route sites the admission", () => {
  const ACTIVATOR = { "x-test-user": "act_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
  const codeOf = (res: { json(): { error?: { code?: string } } }): string | undefined =>
    res.json().error?.code;
  const activate = (
    app: { inject: (o: unknown) => Promise<{ statusCode: number; json<T = unknown>(): T }> },
    body: Record<string, unknown>,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION_READY}/activate`,
      headers: ACTIVATOR,
      payload: body,
    });

  it("keeps the location the admission was already sited at when none is named", async () => {
    // The hospice has several sites; activation does not re-pick one when the admission-details step
    // already sited it (the readiness gate requires that before activation).
    const { app, backend } = makeServer();
    const res = await activate(app, { ifVersion: 1 });
    expect(res.statusCode).toBe(200);
    const detail = await backend.service.getAdmission(ORG, ADMISSION_READY);
    expect(detail?.locationId).toBe(LOC_MAIN);
    await app.close();
  });

  it("activates and sites the admission when a valid location is named", async () => {
    const { app, backend } = makeServer();
    const res = await activate(app, { ifVersion: 1, locationId: LOC_IPU });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ state: string }>().state).toBe("active");
    // The route carried `locationId` through to the service — asserted on the record, not the response,
    // because a route that silently dropped the field would still return 200.
    const detail = await backend.service.getAdmission(ORG, ADMISSION_READY);
    expect(detail?.locationId).toBe(LOC_IPU);
    await app.close();
  });

  it("refuses a location that belongs to another provider entity", async () => {
    const { app } = makeServer();
    const res = await activate(app, { ifVersion: 1, locationId: LOC_OTHER });
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe("M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY");
    await app.close();
  });
});

// Bug 4 — two conflicts that used to surface as a raw unique_violation (500): a second election statement
// for one period (`election_statement_period_idx`) and a transfer-in whose carried sequence collides with
// a period already on the admission (`election_period_admission_seq_idx`). Both are 409 with an M6 code.
describe("M6 — conflicting election-statement draft / transfer-in answer 409, not 500", () => {
  const DRAFTER = {
    "x-test-user": "ed_1",
    "x-test-org": ORG,
    "x-test-roles": "intake_coordinator",
  };
  const XFER = { "x-test-user": "xfer_1", "x-test-org": ORG, "x-test-roles": "intake_coordinator" };
  const codeOf = (res: { json(): { error?: { code?: string } } }): string | undefined =>
    res.json().error?.code;

  it("a second election statement for the same period is 409 ELECTION_STATEMENT_CONFLICT", async () => {
    const { app, backend } = makeServer();
    const draft = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/election-statements`,
        headers: DRAFTER,
        payload: {
          electionPeriodId: EP_OF_ADMISSION,
          effectiveDate: "2026-06-01",
          primaryDiagnosisIcd10: "C34.90",
          electedProviderEntityId: PROVIDER_ENTITY,
          waiverAcknowledged: true,
        },
      });
    expect((await draft()).statusCode).toBe(201);
    const before = backend.events.length;
    const second = await draft();
    expect(second.statusCode).toBe(409);
    expect(codeOf(second)).toBe("ELECTION_STATEMENT_CONFLICT");
    expect(backend.events.length).toBe(before);
    await app.close();
  });

  it("a voided election statement does not block re-drafting the period (one LIVE statement per period)", async () => {
    const { app, backend } = makeServer();
    const draft = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/admissions/${ADMISSION}/election-statements`,
        headers: DRAFTER,
        payload: {
          electionPeriodId: EP_OF_ADMISSION,
          effectiveDate: "2026-06-01",
          primaryDiagnosisIcd10: "C34.90",
          electedProviderEntityId: PROVIDER_ENTITY,
          waiverAcknowledged: true,
        },
      });
    const first = await draft();
    expect(first.statusCode).toBe(201);
    const { id, version } = first.json() as { id: string; version: number };
    await backend.service.voidElection(ORG, id, "drafted in error", version);
    const redraft = await draft();
    expect(redraft.statusCode).toBe(201);
    // The new draft is now the period's live statement: a third draft still conflicts.
    const third = await draft();
    expect(third.statusCode).toBe(409);
    expect(codeOf(third)).toBe("ELECTION_STATEMENT_CONFLICT");
    await app.close();
  });

  it("a transfer-in whose carried period already exists on the admission is 409 TRANSFER_IN_PERIOD_CONFLICT", async () => {
    // ADMISSION already carries benefit period 1 (EP_OF_ADMISSION, as a referral acceptance seeds it).
    const { app, backend } = makeServer();
    const before = (await backend.service.listElectionPeriods(ORG, ADMISSION))?.length;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/transfer-in`,
      headers: XFER,
      payload: {
        direction: "in",
        effectiveDate: "2026-06-01",
        otherHospiceName: "Sending Hospice",
        priorBenefitPeriodSequence: 1,
        priorElectionStartDate: "2026-05-01",
        hospiceMedicalDirectorId: "cccccccc-0000-4000-8000-000000000009",
        narrative: "patient transferred in from another hospice",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("TRANSFER_IN_PERIOD_CONFLICT");
    expect((await backend.service.listElectionPeriods(ORG, ADMISSION))?.length).toBe(before);
    await app.close();
  });
});
