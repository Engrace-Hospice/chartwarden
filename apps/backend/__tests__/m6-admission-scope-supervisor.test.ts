// apps/backend/__tests__/m6-admission-scope-supervisor.test.ts — `admission.scope` for `clinical_supervisor`:
// a supervisor may open an UNSITED admission only inside their own site scope (or when they have none), never a
// sited admission without a provider-entity match or a caseload row. Tenant-wide intake/admin roles are unchanged.
import { describe, expect, it } from "vitest";
import { buildAdmissionAbacPredicates } from "../src/modules/06-admission/abac-predicates";

const ORG = "org_a";
const PE_X = "pe_x";
const PE_Y = "pe_y";
const PATIENT = "patient_1";

type Chart = { providerEntityId: string | null; locationId: string | null } | null;

function scope(admissionPe: string | null, chart: Chart, caseload = false) {
  const predicates = buildAdmissionAbacPredicates({
    resolver: {
      loadAdmission: async () => ({
        patientId: PATIENT,
        providerEntityId: admissionPe,
        locationId: null,
        createdByUserId: "someone_else",
      }),
      loadPatientIntakeFacts: async () => chart,
    } as never,
    isInCaseload: async () => caseload,
  });
  return (roles: string[], providerEntityIds: string[] = [], locationIds: string[] = []) =>
    predicates["admission.scope"]!(
      { organizationId: ORG, userId: "u1", roles, providerEntityIds, locationIds, attributes: {} },
      { id: "adm_1" },
    );
}

describe("admission.scope — clinical_supervisor", () => {
  it("(c) an unrestricted supervisor opens an unsited admission", async () => {
    expect(await scope(null, null)(["clinical_supervisor"])).toBe(true);
  });

  it("(b) a supervisor scoped to site X is denied another site's unsited admission", async () => {
    const check = scope(null, { providerEntityId: PE_Y, locationId: null });
    expect(await check(["clinical_supervisor"], [PE_X])).toBe(false);
  });

  it("a supervisor scoped to site X opens an unsited admission whose chart is sited at X", async () => {
    const check = scope(null, { providerEntityId: PE_X, locationId: null });
    expect(await check(["clinical_supervisor"], [PE_X])).toBe(true);
  });

  it("a site-scoped supervisor gets nothing from a chart that was never sited", async () => {
    expect(
      await scope(null, { providerEntityId: null, locationId: null })(
        ["clinical_supervisor"],
        [PE_X],
      ),
    ).toBe(false);
  });

  it("a location-only restricted supervisor gets nothing from a never-sited chart", async () => {
    const check = scope(null, { providerEntityId: null, locationId: null });
    expect(await check(["clinical_supervisor"], [], ["loc_1"])).toBe(false);
  });

  it("an absent / cross-tenant admission (null facts) is denied, even for an unrestricted supervisor", async () => {
    const predicates = buildAdmissionAbacPredicates({
      resolver: { loadAdmission: async () => null } as never,
      isInCaseload: async () => true,
    });
    const allowed = await predicates["admission.scope"]!(
      {
        organizationId: "org_b",
        userId: "u1",
        roles: ["clinical_supervisor"],
        providerEntityIds: [],
        locationIds: [],
        attributes: {},
      },
      { id: "adm_1" },
    );
    expect(allowed).toBe(false);
  });

  it("(a) a SITED admission stays denied for a supervisor with no caseload row and no entity match", async () => {
    const check = scope(PE_Y, { providerEntityId: PE_Y, locationId: null });
    expect(await check(["clinical_supervisor"])).toBe(false);
    expect(await check(["clinical_supervisor"], [PE_X])).toBe(false);
  });

  it("a SITED admission opens for a supervisor with a provider-entity match or a caseload row", async () => {
    expect(await scope(PE_Y, null)(["clinical_supervisor"], [PE_Y])).toBe(true);
    expect(await scope(PE_Y, null, true)(["clinical_supervisor"])).toBe(true);
  });

  it("an RN with no assignment stays denied; tenant-wide intake/admin roles are unchanged", async () => {
    expect(await scope(null, null)(["rn"])).toBe(false);
    expect(await scope(null, null)(["intake_supervisor"])).toBe(true);
    expect(await scope(null, null)(["org_admin"], [PE_X])).toBe(true);
  });
});

// #605 — the census (`readScopeOf`) lists every admission to org_admin / administrator, so the detail and
// readiness reads (gated by `admission.scope`) must open them too — on a SITED admission with no provider-entity
// match and no caseload. Only these two roles: compliance_officer / survey_coordinator / DON stay narrow here.
describe("admission.scope — org_admin / administrator are org-wide (ADR-0090, #605)", () => {
  const KINDS = [
    "admission",
    "electionPeriod",
    "electionStatement",
    "cti",
    "f2f",
    "loc",
    "complianceWindow",
  ] as const;
  const FACTS = {
    patientId: PATIENT,
    providerEntityId: PE_Y,
    locationId: null,
    createdByUserId: "x",
  };

  function scopeFor(kind: (typeof KINDS)[number]) {
    const loader = async () => FACTS;
    const predicates = buildAdmissionAbacPredicates({
      resolver: {
        loadAdmission: loader,
        loadElectionPeriodScope: loader,
        loadElectionStatementScope: loader,
        loadCtiScope: loader,
        loadF2fScope: loader,
        loadLocScope: loader,
        loadComplianceWindow: loader,
        loadPatientIntakeFacts: async () => null,
      } as never,
      isInCaseload: async () => false,
    });
    return (roles: string[]) =>
      predicates["admission.scope"]!(
        {
          organizationId: ORG,
          userId: "u1",
          roles,
          providerEntityIds: [PE_X],
          locationIds: [],
          attributes: {},
        },
        { id: "r1", resourceKind: kind },
      );
  }

  for (const kind of KINDS) {
    it(`opens a sited admission with no entity match or caseload via ${kind}`, async () => {
      expect(await scopeFor(kind)(["org_admin"])).toBe(true);
      expect(await scopeFor(kind)(["administrator"])).toBe(true);
    });
    it(`keeps compliance_officer, survey_coordinator, clinical_supervisor, rn denied via ${kind}`, async () => {
      for (const role of [
        "compliance_officer",
        "survey_coordinator",
        "director_of_nursing",
        "clinical_supervisor",
        "rn",
      ])
        expect(await scopeFor(kind)([role])).toBe(false);
    });
  }

  it("still fails closed when the facts are absent (cross-tenant / missing), for every resource kind", async () => {
    const none = async () => null;
    const predicates = buildAdmissionAbacPredicates({
      resolver: {
        loadAdmission: none,
        loadElectionPeriodScope: none,
        loadElectionStatementScope: none,
        loadCtiScope: none,
        loadF2fScope: none,
        loadLocScope: none,
        loadComplianceWindow: none,
      } as never,
      isInCaseload: async () => true,
    });
    for (const kind of KINDS) {
      const allowed = await predicates["admission.scope"]!(
        {
          organizationId: ORG,
          userId: "u1",
          roles: ["org_admin", "administrator"],
          providerEntityIds: [],
          locationIds: [],
          attributes: {},
        },
        { id: "r1", resourceKind: kind },
      );
      expect(allowed).toBe(false);
    }
  });
});
