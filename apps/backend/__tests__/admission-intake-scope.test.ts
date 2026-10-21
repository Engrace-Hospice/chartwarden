// apps/backend/__tests__/admission-intake-scope.test.ts — M6's `admission_intake_scope` ABAC predicate and the four
// readmission-flow routes it is OR-composed on (Fastify inject through the full M1 chain):
//
//   GET  /api/v1/admissions/:id/readmission-context        admission.scope    OR admission_intake_scope
//   GET  /api/v1/patients/:patientId/benefit-period-plan   caseload_or_scope  OR admission_intake_scope
//   POST /api/v1/admissions                                caseload_or_scope  OR admission_intake_scope
//   GET  /api/v1/billing/eligibility/hospice-periods (M23) caseload_or_scope  OR admission_intake_scope
//
// The rule: the caller holds an intake role (`intake_coordinator` / `intake_supervisor`, from `context.roles`), the
// patient is a patient of the caller's org, and the patient has no active / on-hold admission. Everything else keeps
// today's answer (a nurse off the caseload: 404; a billing role: its caseload scope, unchanged).
import {
  type AbacContext,
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
  type ReadmissionService,
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";
import { buildBenefitPeriodPlan } from "../src/modules/06-admission/intake/readmission-plan";
// Cross-module test-only imports: the routes bind M7's `caseload_or_scope` and M6's predicate BY NAME.
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { registerEligibilityRoutes } from "../src/modules/23-billing-medicare/routes/eligibility.routes";
import type { M23ReadRouteService } from "../src/modules/23-billing-medicare/routes/read-service";
import type { M23WriteRouteService } from "../src/modules/23-billing-medicare/routes/write-service";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const ORG_B = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
/** Discharged earlier — the readmission candidate. On NOBODY's caseload. */
const P_FREE = "11111111-1111-4111-8111-111111111111";
/** Currently admitted (`active`). */
const P_ACTIVE = "22222222-2222-4222-8222-222222222222";
/** On hold. */
const P_HELD = "33333333-3333-4333-8333-333333333333";
/** Another org's patient. */
const P_ORG_B = "44444444-4444-4444-8444-444444444444";
/** A brand-new prospective patient (no admission at all). */
const P_NEW = "55555555-5555-4555-8555-555555555555";
const ADM_PRIOR = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const ADM_ACTIVE = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const ADM_HELD = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
const ADM_ORG_B = "a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4";
const MD = "66666666-6666-4666-8666-666666666666";
/** The one user with a caseload: P_FREE. */
const CASELOAD_NURSE = "caseload_nurse";

/** The stays are SITED at a provider entity the intake users are not scoped to, so `admission.scope`'s own
 *  unsited-admission allowance for intake roles does not answer for them — only `admission_intake_scope` can. */
const PE = "pe_main";
const RECORDS = [
  {
    id: ADM_PRIOR,
    organizationId: ORG,
    kind: "admission",
    state: "discharged",
    patientId: P_FREE,
    providerEntityId: PE,
  },
  {
    id: ADM_ACTIVE,
    organizationId: ORG,
    kind: "admission",
    state: "active",
    patientId: P_ACTIVE,
    providerEntityId: PE,
  },
  { id: ADM_HELD, organizationId: ORG, kind: "admission", state: "on_hold", patientId: P_HELD },
  {
    id: ADM_ORG_B,
    organizationId: ORG_B,
    kind: "admission",
    state: "discharged",
    patientId: P_ORG_B,
  },
  { id: P_NEW, organizationId: ORG, kind: "patient" },
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? ORG);
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const PLAN = buildBenefitPeriodPlan({
  patientId: P_FREE,
  episodes: [],
  readmitFrom: null,
  openAdmissionExists: false,
  closure: { notrFiled: false, finalClaimFiled: false },
  startDate: "2026-10-07",
});

const FLOW_KEYS = ["admission.read", "admission.create", "billing.eligibility.read"];

function makeServer() {
  const backend = createInMemoryAdmissionBackend({ records: RECORDS });
  const grants = (userId: string, orgId = ORG) => ({
    orgId,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: FLOW_KEYS }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("intake_1"),
      grants("intake_sup_1"),
      grants("nurse_1"),
      grants(CASELOAD_NURSE),
      grants("biller_1"),
      grants("intake_b", ORG_B),
    ]).store,
  );
  const isInCaseload = async (q: { userId: string; patientId: string }) =>
    q.userId === CASELOAD_NURSE && q.patientId === P_FREE;
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(
    buildAdmissionAbacPredicates({ resolver: backend.resolver, isInCaseload }),
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
      isInCaseload: async (q) => isInCaseload(q),
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
  return { app, backend, readmission, getHospicePeriods };
}

const as = (user: string, roles: string, org = ORG) => ({
  "x-test-user": user,
  "x-test-org": org,
  "x-test-roles": roles,
});
const INTAKE = as("intake_1", "intake_coordinator");
const INTAKE_SUP = as("intake_sup_1", "intake_supervisor");
const NURSE = as("nurse_1", "rn");
const BILLER = as("biller_1", "billing_specialist");

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

// ── the predicate itself ──────────────────────────────────────────────────────────────────────────────────

describe("admission_intake_scope — the predicate", () => {
  const predicate = () => {
    const backend = createInMemoryAdmissionBackend({ records: RECORDS });
    const fn = buildAdmissionAbacPredicates({
      resolver: backend.resolver,
      isInCaseload: async () => false,
    }).admission_intake_scope;
    if (!fn) throw new Error("admission_intake_scope is not built");
    return fn;
  };
  const ctx = (roles: string[], organizationId = ORG): AbacContext =>
    ({
      organizationId,
      userId: "u1",
      roles,
      providerEntityIds: [],
      locationIds: [],
      attributes: {},
    }) as unknown as AbacContext;

  it("allows an intake role for a patient of the org with no active admission", async () => {
    const fn = predicate();
    expect(await fn(ctx(["intake_coordinator"]), { patientId: P_FREE })).toBe(true);
    expect(await fn(ctx(["intake_supervisor"]), { patientId: P_NEW })).toBe(true);
    // keyed by the earlier stay (the readmission-context route) → resolved to its patient
    expect(await fn(ctx(["intake_coordinator"]), { admissionId: ADM_PRIOR })).toBe(true);
  });

  it("denies when the patient has an active or on-hold admission", async () => {
    const fn = predicate();
    expect(await fn(ctx(["intake_coordinator"]), { patientId: P_ACTIVE })).toBe(false);
    expect(await fn(ctx(["intake_coordinator"]), { patientId: P_HELD })).toBe(false);
    expect(await fn(ctx(["intake_coordinator"]), { admissionId: ADM_ACTIVE })).toBe(false);
  });

  it("denies another org's patient (and an unknown one)", async () => {
    const fn = predicate();
    expect(await fn(ctx(["intake_coordinator"]), { patientId: P_ORG_B })).toBe(false);
    expect(await fn(ctx(["intake_coordinator"]), { admissionId: ADM_ORG_B })).toBe(false);
    expect(
      await fn(ctx(["intake_coordinator"]), { patientId: "99999999-9999-4999-8999-999999999999" }),
    ).toBe(false);
    // ORG_B's own intake user does reach ORG_B's patient — the org is the caller's, not a constant
    expect(await fn(ctx(["intake_coordinator"], ORG_B), { patientId: P_ORG_B })).toBe(true);
  });

  it("denies a caller without an intake role", async () => {
    const fn = predicate();
    for (const roles of [["rn"], ["billing_specialist"], ["admissions_team"], []])
      expect(await fn(ctx(roles), { patientId: P_FREE }), roles.join()).toBe(false);
  });

  it("fails closed on a missing or malformed target", async () => {
    const fn = predicate();
    expect(await fn(ctx(["intake_coordinator"]), {})).toBe(false);
    expect(await fn(ctx(["intake_coordinator"]), { patientId: "not-a-uuid" })).toBe(false);
    expect(await fn(ctx(["intake_coordinator"]), { patientId: 42 })).toBe(false);
  });
});

// ── the four routes ───────────────────────────────────────────────────────────────────────────────────────

const PLAN_URL = (patientId: string) => `/api/v1/patients/${patientId}/benefit-period-plan`;
const CONTEXT_URL = (admissionId: string) =>
  `/api/v1/admissions/${admissionId}/readmission-context`;
const PERIODS_URL = (patientId: string) =>
  `/api/v1/billing/eligibility/hospice-periods?patientId=${patientId}`;
const CREATE_BODY = (patientId: string) => ({
  patientId,
  intakeMethod: "in_person",
  hospiceMedicalDirectorId: MD,
});

describe("GET /patients/:patientId/benefit-period-plan", () => {
  it("intake, patient not on any caseload → 200", async () => {
    const { app } = makeServer();
    for (const headers of [INTAKE, INTAKE_SUP]) {
      const res = await app.inject({ method: "GET", url: PLAN_URL(P_FREE), headers });
      expect(res.statusCode).toBe(200);
    }
  });

  it("intake, patient currently admitted → 404 (an ongoing stay is the care team's)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: PLAN_URL(P_ACTIVE), headers: INTAKE });
    expect(res.statusCode).toBe(404);
  });

  it("intake, another org's patient → 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: PLAN_URL(P_ORG_B), headers: INTAKE });
    expect(res.statusCode).toBe(404);
  });

  it("nurse without the caseload → 404 as before; the caseload nurse → 200 as before", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: PLAN_URL(P_FREE), headers: NURSE })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: PLAN_URL(P_FREE),
          headers: as(CASELOAD_NURSE, "rn"),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("GET /admissions/:id/readmission-context", () => {
  it("intake, the earlier stay of a patient not on any caseload → 200", async () => {
    const { app, readmission } = makeServer();
    const res = await app.inject({ method: "GET", url: CONTEXT_URL(ADM_PRIOR), headers: INTAKE });
    expect(res.statusCode).toBe(200);
    expect(readmission.getReadmissionContext).toHaveBeenCalledWith(ORG, ADM_PRIOR, {});
  });

  it("intake, an admission of a currently-admitted patient → 404; another org's stay → 404", async () => {
    const { app } = makeServer();
    for (const id of [ADM_ACTIVE, ADM_ORG_B]) {
      const res = await app.inject({ method: "GET", url: CONTEXT_URL(id), headers: INTAKE });
      expect(res.statusCode, id).toBe(404);
    }
  });

  it("nurse without the caseload → 404 as before", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: CONTEXT_URL(ADM_PRIOR), headers: NURSE });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /admissions", () => {
  it("intake supervisor, a readmission / new patient not on any caseload → 201", async () => {
    const { app } = makeServer();
    for (const patientId of [P_FREE, P_NEW]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admissions",
        headers: INTAKE_SUP,
        payload: CREATE_BODY(patientId),
      });
      expect(res.statusCode, patientId).toBe(201);
    }
  });

  it("intake, a currently-admitted patient → 404; another org's patient → 404", async () => {
    const { app } = makeServer();
    for (const patientId of [P_ACTIVE, P_ORG_B]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admissions",
        headers: INTAKE_SUP,
        payload: CREATE_BODY(patientId),
      });
      expect(res.statusCode, patientId).toBe(404);
    }
  });

  it("nurse without the caseload → 404 as before", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: NURSE,
      payload: CREATE_BODY(P_FREE),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /billing/eligibility/hospice-periods (M23)", () => {
  it("intake, patient not on any caseload → 200", async () => {
    const { app, getHospicePeriods } = makeServer();
    const res = await app.inject({ method: "GET", url: PERIODS_URL(P_FREE), headers: INTAKE });
    expect(res.statusCode).toBe(200);
    expect(getHospicePeriods).toHaveBeenCalledTimes(1);
  });

  it("intake, a currently-admitted or other-org patient → 404", async () => {
    const { app } = makeServer();
    for (const patientId of [P_ACTIVE, P_ORG_B]) {
      const res = await app.inject({ method: "GET", url: PERIODS_URL(patientId), headers: INTAKE });
      expect(res.statusCode, patientId).toBe(404);
    }
  });

  it("billing role unchanged: off the caseload → 404, the intake rule does not open it", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: PERIODS_URL(P_FREE), headers: BILLER });
    expect(res.statusCode).toBe(404);
  });

  it("nurse without the caseload → 404; the caseload nurse → 200 (unchanged)", async () => {
    const { app } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: PERIODS_URL(P_FREE), headers: NURSE })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: PERIODS_URL(P_FREE),
          headers: as(CASELOAD_NURSE, "rn"),
        })
      ).statusCode,
    ).toBe(200);
  });

  it("the OTHER eligibility reads keep caseload_or_scope alone (intake → 404)", async () => {
    const { app } = makeServer();
    for (const url of [
      `/api/v1/billing/eligibility?patientId=${P_FREE}`,
      `/api/v1/billing/eligibility/latest?patientId=${P_FREE}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: INTAKE });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe("the intake rule is composed nowhere else on M6", () => {
  it("GET /patients/:patientId/admissions keeps caseload_or_scope alone (intake → 404)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${P_FREE}/admissions`,
      headers: INTAKE,
    });
    expect(res.statusCode).toBe(404);
  });
});
