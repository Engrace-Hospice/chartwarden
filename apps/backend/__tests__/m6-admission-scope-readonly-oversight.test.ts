// apps/backend/__tests__/m6-admission-scope-readonly-oversight.test.ts — #613: the census lists every admission to a
// role in ORG_WIDE_SCOPE_ROLES (readScopeOf → hasOrgWideScope), so a READ of that admission (target.access "read") must
// open for the same roles. A WRITE keeps the narrow scope: oversight is not authority to mutate another site's chart.
import { ORG_WIDE_SCOPE_ROLES } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  admissionScopeAccessOf,
  buildAdmissionAbacPredicates,
} from "../src/modules/06-admission/abac-predicates";

const ORG = "org_a";

function check(roles: string[], target: Record<string, unknown>, facts: object | null = SITED) {
  const predicates = buildAdmissionAbacPredicates({
    resolver: { loadAdmission: async () => facts } as never,
    isInCaseload: async () => false,
  });
  return predicates["admission.scope"]!(
    {
      organizationId: ORG,
      userId: "u1",
      roles,
      providerEntityIds: [],
      locationIds: [],
      attributes: {},
    },
    target,
  );
}

const SITED = { patientId: "p1", providerEntityId: "pe_x", locationId: null, createdByUserId: "o" };

describe("admission.scope — read-only org-wide oversight (#613)", () => {
  it.each([...ORG_WIDE_SCOPE_ROLES])(
    "%s opens a sited admission outside its caseload for a READ",
    async (role) => {
      expect(await check([role], { id: "a1", access: "read" })).toBe(true);
    },
  );

  it.each(["compliance_officer", "director_of_nursing", "survey_coordinator"])(
    "%s is refused a WRITE on a sited admission outside its caseload",
    async (role) => {
      expect(await check([role], { id: "a1", access: "write" })).toBe(false);
      expect(await check([role], { id: "a1" })).toBe(false); // no access marker = write
    },
  );

  it.each(["medical_director", "administrator", "org_admin"])(
    "%s keeps its own scope arm for a WRITE (the read arm did not replace it)",
    async (role) => {
      expect(await check([role], { id: "a1", access: "write" })).toBe(true);
    },
  );

  it("a role outside ORG_WIDE_SCOPE_ROLES gets nothing extra from a READ", async () => {
    expect(await check(["rn"], { id: "a1", access: "read" })).toBe(false);
  });

  it("an absent / cross-tenant admission stays denied for a READ", async () => {
    expect(await check(["compliance_officer"], { id: "a1", access: "read" }, null)).toBe(false);
  });

  it("only a .read action is a read", () => {
    expect(admissionScopeAccessOf("admission.read")).toBe("read");
    expect(admissionScopeAccessOf("cti.read")).toBe("read");
    expect(admissionScopeAccessOf("admission.update")).toBe("write");
    expect(admissionScopeAccessOf("election.sign")).toBe("write");
    expect(admissionScopeAccessOf("reader.write")).toBe("write");
  });
});
