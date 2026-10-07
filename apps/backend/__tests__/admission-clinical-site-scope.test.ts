// apps/backend/__tests__/admission-clinical-site-scope.test.ts — M6's `admission_clinical_site_scope` ABAC predicate:
// a nurse, physician, NP or PA (ADMITTING_CLINICIAN_ROLE_KEYS) opens a new admission or a readmission for a patient
// of THEIR OWN SITE. It is OR-composed beside `caseload_or_scope` / `admission.scope` and `admission_intake_scope` on
// exactly the new-admission / readmission routes:
//
//   GET  /api/v1/admissions/:id/readmission-context
//   GET  /api/v1/patients/:patientId/benefit-period-plan
//   POST /api/v1/admissions                       (target: body.patientId + body.readmittedFromAdmissionId)
//   GET  /api/v1/billing/eligibility/hospice-periods (M23)
//
// The rule: an admitting clinician role (server-assembled `context.roles`), a patient of the caller's org with no
// active / on-hold admission, and the patient's site (location when both sides know one, else provider entity) is in
// the caller's scope. A sited patient is decided by its own site; an unsited patient falls back to the named earlier
// stay's site; a brand-new patient with no admission history at all has no site yet and is reachable by any admitting
// clinician who has a site scope. Everything else is denied (other site, other org, no scope, no role).
import {
  type AbacContext,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type ReadmissionService,
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";
import { buildBenefitPeriodPlan } from "../src/modules/06-admission/intake/readmission-plan";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { registerEligibilityRoutes } from "../src/modules/23-billing-medicare/routes/eligibility.routes";
import type { M23ReadRouteService } from "../src/modules/23-billing-medicare/routes/read-service";
import type { M23WriteRouteService } from "../src/modules/23-billing-medicare/routes/write-service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ORG_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const PE_A = "pe_a";
const PE_B = "pe_b";
const LOC_A1 = "loc_a1";
const LOC_A2 = "loc_a2";

/** Discharged earlier from site A (PE_A / LOC_A1); the chart is sited there. */
const P_A = "11111111-1111-4111-8111-111111111111";
/** Discharged earlier from site B. */
const P_B = "22222222-2222-4222-8222-222222222222";
/** Currently admitted at site A. */
const P_ACTIVE_A = "33333333-3333-4333-8333-333333333333";
/** Another org's patient, sited at a PE id that the org-B record happens to share. */
const P_ORG_B = "44444444-4444-4444-8444-444444444444";
/** A brand-new prospective patient — no admission, never sited. */
const P_NEW = "55555555-5555-4555-8555-555555555555";
/** A never-admitted patient whose referral was taken at site B. */
const P_REF_B = "12121212-1212-4121-8121-121212121212";
/** A legacy chart left unsited, with an earlier stay at site A. */
const P_UNSITED = "66666666-6666-4666-8666-666666666666";
/** Sited at PE_A but at the OTHER location of it (LOC_A2). */
const P_A2 = "77777777-7777-4777-8777-777777777777";

const ADM_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const ADM_B = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const ADM_ACTIVE_A = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
const ADM_ORG_B = "a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4";
const ADM_UNSITED = "a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5";
const MD = "99999999-9999-4999-8999-999999999999";

const RECORDS = [
  { id: P_A, organizationId: ORG, kind: "patient", providerEntityId: PE_A, locationId: LOC_A1 },
  { id: P_B, organizationId: ORG, kind: "patient", providerEntityId: PE_B, locationId: null },
  {
    id: P_ACTIVE_A,
    organizationId: ORG,
    kind: "patient",
    providerEntityId: PE_A,
    locationId: LOC_A1,
  },
  { id: P_ORG_B, organizationId: ORG_B, kind: "patient", providerEntityId: PE_A, locationId: null },
  { id: P_NEW, organizationId: ORG, kind: "patient" },
  { id: P_UNSITED, organizationId: ORG, kind: "patient" },
  { id: P_A2, organizationId: ORG, kind: "patient", providerEntityId: PE_A, locationId: LOC_A2 },
  {
    id: ADM_A,
    organizationId: ORG,
    kind: "admission",
    state: "discharged",
    patientId: P_A,
    providerEntityId: PE_A,
    locationId: LOC_A1,
  },
  {
    id: ADM_B,
    organizationId: ORG,
    kind: "admission",
    state: "discharged",
    patientId: P_B,
    providerEntityId: PE_B,
  },
  {
    id: ADM_ACTIVE_A,
    organizationId: ORG,
    kind: "admission",
    state: "active",
    patientId: P_ACTIVE_A,
    providerEntityId: PE_A,
    locationId: LOC_A1,
  },
  {
    id: ADM_ORG_B,
    organizationId: ORG_B,
    kind: "admission",
    state: "discharged",
    patientId: P_ORG_B,
    providerEntityId: PE_A,
  },
  {
    id: ADM_UNSITED,
    organizationId: ORG,
    kind: "admission",
    state: "discharged",
    patientId: P_UNSITED,
    providerEntityId: PE_A,
  },
];

const ctx = (
  roles: string[],
  site: { pe?: string[]; loc?: string[] } = { pe: [PE_A] },
  organizationId = ORG,
): AbacContext =>
  ({
    organizationId,
    userId: "u1",
    roles,
    providerEntityIds: site.pe ?? [],
    locationIds: site.loc ?? [],
    attributes: {},
  }) as unknown as AbacContext;

function predicate() {
  const backend = createInMemoryAdmissionBackend({ records: RECORDS });
  const fn = buildAdmissionAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => false,
  }).admission_clinical_site_scope;
  if (!fn) throw new Error("admission_clinical_site_scope is not built");
  return fn;
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("admission_clinical_site_scope — the predicate", () => {
  it("allows every admitting clinician role for a patient of their own provider entity", async () => {
    const fn = predicate();
    for (const role of ["rn", "lpn", "rn_case_manager", "md", "hospice_physician", "np", "pa"])
      expect(await fn(ctx([role]), { patientId: P_A }), role).toBe(true);
  });

  it("allows the readmission keyed by the earlier stay, and a POST naming patient + stay", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), { admissionId: ADM_A })).toBe(true);
    expect(await fn(ctx(["rn"]), { patientId: P_A, priorAdmissionId: ADM_A })).toBe(true);
  });

  it("denies a patient of another site (provider entity), by patient and by stay", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), { patientId: P_B })).toBe(false);
    expect(await fn(ctx(["rn"]), { admissionId: ADM_B })).toBe(false);
    // the site-B nurse reaches it
    expect(await fn(ctx(["rn"], { pe: [PE_B] }), { patientId: P_B })).toBe(true);
  });

  it("uses the location when both sides know one: same PE, other location → deny", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"], { pe: [PE_A], loc: [LOC_A1] }), { patientId: P_A })).toBe(true);
    expect(await fn(ctx(["rn"], { pe: [PE_A], loc: [LOC_A1] }), { patientId: P_A2 })).toBe(false);
    expect(await fn(ctx(["rn"], { pe: [], loc: [LOC_A2] }), { patientId: P_A2 })).toBe(true);
  });

  it("denies a POST pairing a patient with ANOTHER patient's stay (no borrowing a site)", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"], { pe: [PE_A] }), { patientId: P_B, priorAdmissionId: ADM_A })).toBe(
      false,
    );
  });

  it("denies a patient with an active / on-hold admission (an ongoing stay is the care team's)", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), { patientId: P_ACTIVE_A })).toBe(false);
    expect(await fn(ctx(["rn"]), { admissionId: ADM_ACTIVE_A })).toBe(false);
  });

  it("denies cross-tenant, even when the PE id matches", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), { patientId: P_ORG_B })).toBe(false);
    expect(await fn(ctx(["rn"]), { admissionId: ADM_ORG_B })).toBe(false);
    expect(await fn(ctx(["rn"]), { patientId: P_A, priorAdmissionId: ADM_ORG_B })).toBe(false);
    // org B's own nurse at that PE reaches org B's patient — the org is the caller's
    expect(await fn(ctx(["rn"], { pe: [PE_A] }, ORG_B), { patientId: P_ORG_B })).toBe(true);
  });

  it("a never-admitted patient REFERRED to another site belongs to that site (the referral sites it)", async () => {
    const backend = createInMemoryAdmissionBackend({
      records: [
        ...RECORDS,
        { id: P_REF_B, organizationId: ORG, kind: "patient" },
        {
          id: "r0r0r0r0-r0r0-4r0r-8r0r-r0r0r0r0r0r0",
          organizationId: ORG,
          kind: "referral",
          patientId: P_REF_B,
          providerEntityId: PE_B,
        },
      ],
    });
    const fn = buildAdmissionAbacPredicates({
      resolver: backend.resolver,
      isInCaseload: async () => false,
    }).admission_clinical_site_scope;
    if (!fn) throw new Error("missing");
    expect(await fn(ctx(["rn"]), { patientId: P_REF_B })).toBe(false);
    expect(await fn(ctx(["rn"], { pe: [PE_B] }), { patientId: P_REF_B })).toBe(true);
  });

  it("a brand-new patient (no admission, never sited) is reachable by a clinician with a site scope", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), { patientId: P_NEW })).toBe(true);
    expect(await fn(ctx(["rn"], { pe: [], loc: [] }), { patientId: P_NEW })).toBe(false);
  });

  it("an unsited legacy chart falls back to the named earlier stay's site only", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), { admissionId: ADM_UNSITED })).toBe(true);
    expect(await fn(ctx(["rn"], { pe: [PE_B] }), { admissionId: ADM_UNSITED })).toBe(false);
    // by patient alone it has history but no site → deny
    expect(await fn(ctx(["rn"]), { patientId: P_UNSITED })).toBe(false);
  });

  it("denies a caller without an admitting clinician role (external, intake, billing, none)", async () => {
    const fn = predicate();
    for (const roles of [
      ["physician_office"],
      ["intake_coordinator"],
      ["billing_specialist"],
      ["msw"],
      [],
    ])
      expect(await fn(ctx(roles), { patientId: P_A }), roles.join()).toBe(false);
  });

  it("denies a caller with no site scope at all", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"], { pe: [], loc: [] }), { patientId: P_A })).toBe(false);
  });

  it("fails closed on a missing, malformed or unknown target", async () => {
    const fn = predicate();
    expect(await fn(ctx(["rn"]), {})).toBe(false);
    expect(await fn(ctx(["rn"]), { patientId: "not-a-uuid" })).toBe(false);
    expect(await fn(ctx(["rn"]), { patientId: 42 })).toBe(false);
    expect(await fn(ctx(["rn"]), { patientId: "88888888-8888-4888-8888-888888888888" })).toBe(
      false,
    );
    expect(
      await fn(ctx(["rn"]), {
        patientId: P_A,
        priorAdmissionId: "88888888-8888-4888-8888-888888888888",
      }),
    ).toBe(false);
  });
});

// ── `admission.scope` — reaching the admission a clinician just opened ─────────────────────────────────────
// A new admission is unsited until its election is drafted (the elected provider entity sites it), and
// `admission.scope` lets only intake / admin roles reach an UNSITED admission — so the clinician who just opened it got
// a 404 on its detail page. The clinician arm: an admitting clinician with a site scope reaches an unsited admission
// whose PATIENT is sited at their site, or — a never-sited patient — any unsited admission of it.
describe("admission.scope — an admitting clinician and an unsited admission", () => {
  const P_PENDING_A = "88888888-8888-4888-8888-88888888888a";
  const ADM_PENDING_A = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1"; // unsited, patient sited at site A
  const ADM_PENDING_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"; // unsited, patient sited at site B
  const ADM_PENDING_NEW = "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3"; // unsited, never-sited patient, opened by nurse B
  const ADM_PENDING_MINE = "b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4"; // unsited, never-sited patient, opened by u1
  const P_UNSITED_NEW = "99999999-9999-4999-8999-99999999999a";
  const records = [
    ...RECORDS,
    {
      id: P_PENDING_A,
      organizationId: ORG,
      kind: "patient",
      providerEntityId: PE_A,
      locationId: LOC_A1,
    },
    {
      id: ADM_PENDING_A,
      organizationId: ORG,
      kind: "admission",
      state: "pending",
      patientId: P_PENDING_A,
    },
    { id: ADM_PENDING_B, organizationId: ORG, kind: "admission", state: "pending", patientId: P_B },
    {
      id: ADM_PENDING_NEW,
      organizationId: ORG,
      kind: "admission",
      state: "pending",
      patientId: P_NEW,
      createdByUserId: "u_b", // opened by site B's nurse
    },
    {
      id: ADM_PENDING_MINE,
      organizationId: ORG,
      kind: "admission",
      state: "pending",
      patientId: P_UNSITED_NEW,
      createdByUserId: "u1", // opened by the caller
    },
    { id: P_UNSITED_NEW, organizationId: ORG, kind: "patient" },
  ];
  const scope = () => {
    const backend = createInMemoryAdmissionBackend({ records });
    const fn = buildAdmissionAbacPredicates({
      resolver: backend.resolver,
      isInCaseload: async () => false,
    })["admission.scope"];
    if (!fn) throw new Error("admission.scope is not built");
    return fn;
  };

  it("reaches an unsited admission of a patient at their own site", async () => {
    expect(await scope()(ctx(["rn"]), { id: ADM_PENDING_A })).toBe(true);
    expect(await scope()(ctx(["md"], { pe: [], loc: [LOC_A1] }), { id: ADM_PENDING_A })).toBe(true);
  });

  it("not one of a patient at another site, nor across the location boundary", async () => {
    expect(await scope()(ctx(["rn"]), { id: ADM_PENDING_B })).toBe(false);
    expect(await scope()(ctx(["rn"], { pe: [PE_A], loc: [LOC_A2] }), { id: ADM_PENDING_A })).toBe(
      false,
    );
  });

  it("a never-sited patient's pending admission: only the clinician who opened it, never any site scope", async () => {
    // Nurse A (u1, site A) must NOT reach the pending admission site B's nurse opened for a brand-new patient —
    // the old "chart never sited ⇒ allow" rule let any admitting clinician with any site scope reach it.
    expect(await scope()(ctx(["rn"]), { id: ADM_PENDING_NEW })).toBe(false);
    expect(await scope()(ctx(["rn"], { pe: [PE_B] }), { id: ADM_PENDING_NEW })).toBe(false);
    // …her own, she does (even with no site scope: she created it)
    expect(await scope()(ctx(["rn"]), { id: ADM_PENDING_MINE })).toBe(true);
    // the creator arm is for admitting clinicians only, and never across orgs
    expect(await scope()(ctx(["msw"]), { id: ADM_PENDING_MINE })).toBe(false);
    expect(await scope()(ctx(["rn"], { pe: [PE_A] }, ORG_B), { id: ADM_PENDING_MINE })).toBe(false);
  });

  it("gives nothing to a non-admitting role, and nothing new on a SITED admission", async () => {
    for (const roles of [["msw"], ["physician_office"], ["billing_specialist"]])
      expect(await scope()(ctx(roles), { id: ADM_PENDING_A }), roles.join()).toBe(false);
    // sited admissions keep the provider-entity arm alone: site B's stay is not site A's nurse's
    expect(await scope()(ctx(["rn"]), { id: ADM_B })).toBe(false);
    expect(await scope()(ctx(["rn"]), { id: ADM_A })).toBe(true);
  });

  it("never reaches another org's admission", async () => {
    expect(await scope()(ctx(["rn"], { pe: [PE_A] }, ORG_B), { id: ADM_PENDING_A })).toBe(false);
  });
});

// ── the routes ────────────────────────────────────────────────────────────────────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? ORG);
  const list = (h: string) => {
    const v = request.headers[h];
    return typeof v === "string" && v.length > 0 ? v.split(",") : [];
  };
  request.context.roles = list("x-test-roles");
  request.context.providerEntityIds = list("x-test-pe");
  request.context.locationIds = list("x-test-loc");
}

const PLAN = buildBenefitPeriodPlan({
  patientId: P_A,
  episodes: [],
  readmitFrom: null,
  openAdmissionExists: false,
  closure: { notrFiled: false, finalClaimFiled: false },
  startDate: "2026-10-07",
});

const FLOW_KEYS = ["admission.read", "admission.create", "billing.eligibility.read"];

function makeServer() {
  const backend = createInMemoryAdmissionBackend({ records: RECORDS });
  const grant = (userId: string, keys: string[], orgId = ORG) => ({
    orgId,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      // `admission.update` too, so the PATCH case below is decided by ABAC (404), not RBAC.
      grant("nurse_a", [...FLOW_KEYS, "admission.update"]),
      grant("nurse_b", [...FLOW_KEYS, "admission.update"]),
      grant("nurse_noperm", ["admission.read"]),
      grant("office", FLOW_KEYS),
      grant("nurse_org_b", FLOW_KEYS, ORG_B),
    ]).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(
    buildAdmissionAbacPredicates({ resolver: backend.resolver, isInCaseload: async () => false }),
  ))
    registry.register(name, fn);
  registry.register(
    "caseload_or_scope",
    buildCarePlanAbacPredicates({
      resolver: {
        loadPlan: async () => null,
        loadProblem: async () => null,
        loadVersion: async () => null,
      },
      isInCaseload: async () => false,
    }).caseload_or_scope,
  );
  registerAbacRegistry(registry);
  const readmission = {
    getReadmissionContext: vi.fn<ReadmissionService["getReadmissionContext"]>(async () => PLAN),
    getPatientBenefitPeriodPlan: vi.fn<ReadmissionService["getPatientBenefitPeriodPlan"]>(
      async () => PLAN,
    ),
  };
  const getHospicePeriods = vi.fn(async () => ({ status: "no_check_on_file" }));
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, {
    service: backend.service,
    caseloadPatientIds: async () => [],
    dischargeWorklist: { list: async () => ({ items: [], nextCursor: null }) },
    readmission,
  });
  registerEligibilityRoutes(app, {
    readService: { getHospicePeriods } as unknown as M23ReadRouteService,
    writeService: {} as unknown as M23WriteRouteService,
  });
  return { app, readmission, getHospicePeriods };
}

const hdr = (user: string, roles: string, pe: string, org = ORG) => ({
  "x-test-user": user,
  "x-test-org": org,
  "x-test-roles": roles,
  "x-test-pe": pe,
});
const NURSE_A = hdr("nurse_a", "rn", PE_A);
const NURSE_B = hdr("nurse_b", "rn", PE_B);
const CREATE = (patientId: string, readmittedFromAdmissionId?: string) => ({
  patientId,
  intakeMethod: "in_person",
  hospiceMedicalDirectorId: MD,
  ...(readmittedFromAdmissionId ? { readmittedFromAdmissionId } : {}),
});

describe("the readmission-flow routes for an admitting clinician", () => {
  it("own site: readmission context, plan and HETS history → 200", async () => {
    const { app, getHospicePeriods } = makeServer();
    for (const url of [
      `/api/v1/admissions/${ADM_A}/readmission-context`,
      `/api/v1/patients/${P_A}/benefit-period-plan`,
      `/api/v1/billing/eligibility/hospice-periods?patientId=${P_A}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: NURSE_A });
      expect(res.statusCode, url).toBe(200);
    }
    expect(getHospicePeriods).toHaveBeenCalledTimes(1);
  });

  it("another site's patient → 404 on every read", async () => {
    const { app } = makeServer();
    for (const url of [
      `/api/v1/admissions/${ADM_B}/readmission-context`,
      `/api/v1/patients/${P_B}/benefit-period-plan`,
      `/api/v1/billing/eligibility/hospice-periods?patientId=${P_B}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: NURSE_A });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("POST /admissions: a new admission and a readmission at their own site → 201", async () => {
    const { app } = makeServer();
    const fresh = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: NURSE_A,
      payload: CREATE(P_NEW),
    });
    expect(fresh.statusCode).toBe(201);
    const readmit = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: NURSE_B,
      payload: CREATE(P_B, ADM_B),
    });
    expect(readmit.statusCode).toBe(201);
  });

  it("a pending admission nurse B opened for a brand-new patient: nurse A cannot read or update it; B can", async () => {
    const { app } = makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: NURSE_B,
      payload: CREATE(P_NEW),
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/admissions/${id}`, headers: NURSE_B }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/admissions/${id}`, headers: NURSE_A }))
        .statusCode,
    ).toBe(404);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admissions/${id}`,
      headers: NURSE_A,
      payload: { hospicePhysicianId: MD, ifVersion: 0 },
    });
    expect(patch.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/admissions/${id}`,
          headers: hdr("nurse_org_b", "rn", PE_B, ORG_B),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("POST /admissions: another site, an active patient, another org → 404", async () => {
    const { app } = makeServer();
    const cases: [Record<string, string>, Record<string, unknown>][] = [
      [NURSE_A, CREATE(P_B)],
      [NURSE_A, CREATE(P_B, ADM_A)],
      [NURSE_A, CREATE(P_ACTIVE_A)],
      [NURSE_A, CREATE(P_ORG_B)],
      [hdr("nurse_org_b", "rn", PE_B, ORG_B), CREATE(P_A, ADM_A)],
    ];
    for (const [headers, payload] of cases) {
      const res = await app.inject({ method: "POST", url: "/api/v1/admissions", headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(404);
    }
  });

  it("POST /admissions without admission.create → 403 even at their own site", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: hdr("nurse_noperm", "rn", PE_A),
      payload: CREATE(P_A),
    });
    expect(res.statusCode).toBe(403);
  });

  it("an external role holding the keys still cannot reach a patient (physician_office → 404)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: hdr("office", "physician_office", PE_A),
      payload: CREATE(P_A),
    });
    expect(res.statusCode).toBe(404);
  });

  it("the site rule is composed nowhere else on M6 (GET /patients/:id/admissions → 404)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${P_A}/admissions`,
      headers: NURSE_A,
    });
    expect(res.statusCode).toBe(404);
  });
});
