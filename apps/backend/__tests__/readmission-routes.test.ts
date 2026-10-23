// apps/backend/__tests__/readmission-routes.test.ts — the readmission workflow's HTTP surface through the full M1 chain
// (Fastify inject): GET /admissions/:id/readmission-context and GET /patients/:patientId/benefit-period-plan
// (permission + scope gating, query validation, 404, 503 when unbound), the `recently_discharged` worklist bucket,
// and POST /admissions carrying a benefit period (validated, period number reaches the first election period).
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
  type DischargeWorklistService,
  type ReadmissionService,
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";
import { buildBenefitPeriodPlan } from "../src/modules/06-admission/intake/readmission-plan";
// The patient-keyed routes bind M7's shared `caseload_or_scope` by name (test-only cross-module import, as
// admission-routes.test.ts).
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const MD = "22222222-2222-4222-8222-222222222222";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = String(request.headers["x-test-org"] ?? "");
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const PLAN = buildBenefitPeriodPlan({
  patientId: PATIENT,
  episodes: [
    {
      admissionId: "adm_prior",
      patientId: PATIENT,
      admissionState: "discharged",
      startedOn: "2026-01-01",
      endedOn: "2026-02-01",
      endKind: "live_discharge",
      dischargeType: "no_longer_terminal",
      lastRanSequence: 1,
      endingEventId: "de_1",
      transferredIn: null,
    },
  ],
  readmitFrom: { admissionId: "adm_prior", state: "discharged" },
  openAdmissionExists: false,
  closure: { notrFiled: false, finalClaimFiled: false },
  startDate: "2026-03-01",
});

function makeServer(opts: { bound?: boolean; inCaseload?: boolean } = {}) {
  const backend = createInMemoryAdmissionBackend({
    records: [
      {
        id: "adm_prior",
        organizationId: ORG,
        kind: "admission",
        state: "discharged",
        patientId: PATIENT,
        providerEntityId: "pe_x",
      },
    ],
  });
  const grants = (userId: string, permissionKeys: string[]) => ({
    orgId: ORG,
    userId,
    grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("reader_1", ["admission.read"]),
      grants("intake_1", ["admission.read", "admission.create"]),
      grants("oversight_1", ["admission.read"]),
      grants("nobody_1", []),
    ]).store,
  );
  const registry = createPredicateRegistry();
  for (const [name, fn] of Object.entries(
    buildAdmissionAbacPredicates({
      resolver: backend.resolver,
      isInCaseload: async () => opts.inCaseload ?? true,
    }),
  )) {
    registry.register(name, fn);
  }
  registry.register(
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
  registerAbacRegistry(registry);
  const readmission = {
    getReadmissionContext: vi.fn<ReadmissionService["getReadmissionContext"]>(async (_o, id) =>
      id === "adm_prior" ? PLAN : null,
    ),
    getPatientBenefitPeriodPlan: vi.fn<ReadmissionService["getPatientBenefitPeriodPlan"]>(
      async () => PLAN,
    ),
  };
  const list = vi.fn<DischargeWorklistService["list"]>(async () => ({
    items: [],
    nextCursor: null,
  }));
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, {
    service: backend.service,
    caseloadPatientIds: async () => [PATIENT],
    dischargeWorklist: { list },
    ...(opts.bound === false ? {} : { readmission }),
  });
  return { app, readmission, list, backend };
}

const as = (user: string, roles = "intake_coordinator") => ({
  "x-test-user": user,
  "x-test-org": ORG,
  "x-test-roles": roles,
});

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("GET /api/v1/admissions/:id/readmission-context", () => {
  it("returns the plan and hands the service the parsed query", async () => {
    const { app, readmission } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admissions/adm_prior/readmission-context?sequence=3&startDate=2026-03-01",
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestion.suggestedSequence).toBe(2);
    expect(res.json().noeBlocked).toBe(true);
    expect(readmission.getReadmissionContext).toHaveBeenCalledWith(ORG, "adm_prior", {
      sequence: 3,
      startDate: "2026-03-01",
    });
  });

  // #644: the census lists these roles every admission, so the context read must open it too (admission.scope's
  // read arm needs the `access` marker; this route builds its own target).
  it.each(["compliance_officer", "director_of_nursing", "survey_coordinator"])(
    "200 for %s on a sited admission outside its caseload",
    async (role) => {
      const { app } = makeServer({ inCaseload: false });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admissions/adm_prior/readmission-context",
        headers: as("oversight_1", role),
      });
      expect(res.statusCode).toBe(200);
    },
  );

  it("404 for a role outside the org-wide set on the same admission", async () => {
    const { app } = makeServer({ inCaseload: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admissions/adm_prior/readmission-context",
      headers: as("oversight_1", "rn"),
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 without admission.read", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admissions/adm_prior/readmission-context",
      headers: as("nobody_1"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("422 on a malformed benefit period / date", async () => {
    const { app } = makeServer();
    for (const q of ["sequence=0", "sequence=abc", "startDate=05-01-2026"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/admissions/adm_prior/readmission-context?${q}`,
        headers: as("reader_1"),
      });
      expect(res.statusCode, q).toBe(422);
    }
  });

  it("404 for an admission outside the caller's org (scope predicate)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admissions/adm_unknown/readmission-context",
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(404);
  });

  it("503 DEGRADED when the readmission service is not bound", async () => {
    const { app } = makeServer({ bound: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admissions/adm_prior/readmission-context",
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /api/v1/patients/:patientId/benefit-period-plan", () => {
  it("returns the patient's plan", async () => {
    const { app, readmission } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/benefit-period-plan`,
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requirements.sequence).toBe(2);
    expect(readmission.getPatientBenefitPeriodPlan).toHaveBeenCalledWith(ORG, PATIENT, {});
  });

  it("403 without admission.read", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/benefit-period-plan`,
      headers: as("nobody_1"),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/v1/discharges/worklist?bucket=recently_discharged", () => {
  it("is a valid bucket gated on admission.read", async () => {
    const { app, list } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discharges/worklist?bucket=recently_discharged",
      headers: as("reader_1"),
    });
    expect(res.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(ORG, { bucket: "recently_discharged" }, expect.anything());
  });
});

describe("POST /api/v1/admissions with a benefit period", () => {
  const body = {
    patientId: PATIENT,
    intakeMethod: "in_person",
    hospiceMedicalDirectorId: MD,
  };

  it("creates the admission with the entered period as its first election period", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: as("intake_1"),
      payload: {
        ...body,
        readmittedFromAdmissionId: "adm_prior",
        benefitPeriod: { sequence: 2, source: "hets_confirmed", confirmedOn: "2026-01-02" },
        admissionDate: "2026-03-01",
      },
    });
    expect(res.statusCode).toBe(201);
    const periods = await backend.service.listElectionPeriods(ORG, res.json().id);
    expect(periods).toHaveLength(1);
  });

  it("422 on an invalid benefit period entry (schema and domain)", async () => {
    const { app } = makeServer();
    const bad = [
      { sequence: 0, source: "staff_entered_unverified" },
      { sequence: 2, source: "made_up" },
      { sequence: 2, source: "hets_confirmed" }, // confirmation date required
    ];
    for (const benefitPeriod of bad) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admissions",
        headers: as("intake_1"),
        payload: { ...body, benefitPeriod },
      });
      expect(res.statusCode, JSON.stringify(benefitPeriod)).toBe(422);
    }
  });

  it("422 on an F2F exception outside period 3+", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admissions",
      headers: as("intake_1"),
      payload: {
        ...body,
        benefitPeriod: { sequence: 2, source: "staff_entered_unverified" },
        f2fException: { reason: "Weekend emergency admission, no physician" },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("F2F_EXCEPTION_INVALID");
  });
});
