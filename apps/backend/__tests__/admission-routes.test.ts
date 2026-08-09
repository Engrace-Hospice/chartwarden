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
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";

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
const ADMISSION = "adm_seed";
const ADMISSION_B = "adm_seed_b";
const F2F = "f2f_seed";
const DISCHARGE = "dis_seed";
const WINDOW = "cw_seed";

// Grants: an intake coordinator (referral/admission writes), a clinician (reads + cti/f2f), a
// medical director (discharge/cosign), and a compliance officer (override).
const PERMISSION_SEED = [
  {
    userId: "intake_1",
    permissions: [
      "referral.create",
      "referral.read",
      "admission.create",
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
      "election.read",
      "loc.change",
      "loc.read",
    ],
  },
  {
    userId: "md_1",
    permissions: ["f2f.attest", "discharge.for_cause", "discharge.cosign_for_cause"],
  },
  { userId: "co_1", permissions: ["compliance.read", "compliance.override"] },
];

function makeServer(
  options: { isInCaseload?: (q: { organizationId: string; userId: string; patientId: string }) => Promise<boolean> } = {},
) {
  const backend = createInMemoryAdmissionBackend({
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "active",
        patientId: "pat_1",
      },
      {
        id: ADMISSION_B,
        organizationId: ORG_B,
        kind: "admission",
        state: "active",
        patientId: "pat_b",
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
        patientId: "pat_1",
      },
      {
        id: WINDOW,
        organizationId: ORG,
        kind: "compliance_window",
        state: "open",
        admissionId: ADMISSION,
        patientId: "pat_1",
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
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, { service: backend.service });
  return { app, backend };
}

const INTAKE = {
  "x-test-user": "intake_1",
  "x-test-org": ORG,
  "x-test-roles": "intake_coordinator",
};
const RN = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "clinical_rn" };
const RN_AS_NP = { "x-test-user": "rn_1", "x-test-org": ORG, "x-test-roles": "np" };
const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "medical_director" };
const MD_NO_ROLE = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "clinical_admin" };
const CO = { "x-test-user": "co_1", "x-test-org": ORG, "x-test-roles": "compliance_officer" };
const CO_NO_ROLE = { "x-test-user": "co_1", "x-test-org": ORG, "x-test-roles": "clinical_admin" };

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
    const res = await app.inject({ method: "GET", url: `/api/v1/admissions/${ADMISSION}` });
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

  it("GET /patients/:patientId/election-certification assembles the aggregate for a reader (200)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients/pat_1/election-certification",
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

  it("denies /patients/:patientId/election-certification without election.read (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients/pat_1/election-certification",
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
        attestationNarrative: "Patient continues to meet hospice eligibility.",
        ifVersion: 1,
      },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/face-to-face/${F2F}/attest`,
      headers: RN_AS_NP,
      payload: {
        attestationNarrative: "Patient continues to meet hospice eligibility.",
        ifVersion: 1,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe("attested");
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
      payload: { cosignerName: "Dr. House", cosignerNpi: "1234567893", ifVersion: 1 },
    });
    expect(noRole.statusCode).toBe(403);
    await denied.app.close();

    const allowed = makeServer();
    const ok = await allowed.app.inject({
      method: "POST",
      url: `/api/v1/discharges/${DISCHARGE}/cosign-for-cause`,
      headers: MD,
      payload: { cosignerName: "Dr. House", cosignerNpi: "1234567893", ifVersion: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe("completed");
    await allowed.app.close();
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
    expect(res.json().state).toBe("active");
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
});
