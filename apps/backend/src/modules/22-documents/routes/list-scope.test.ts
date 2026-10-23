import { describe, expect, it } from "vitest";
import { resolveDocumentListScope } from "./list-scope";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "55555555-5555-4555-8555-555555555555";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const base = {
  organizationId: ORG,
  userId: USER,
  roles: ["rn_case_manager"],
  hasOrgWideKey: async () => false,
  resolveCaseload: async () => [P1],
};

describe("resolveDocumentListScope (F-023: the document list is caseload-scoped)", () => {
  it("is org-wide (null) for an org-wide oversight role, without reading the caseload", async () => {
    const scope = await resolveDocumentListScope({
      ...base,
      roles: ["director_of_nursing"],
      hasOrgWideKey: async () => {
        throw new Error("an org-wide role must not need a permission lookup");
      },
      resolveCaseload: async () => {
        throw new Error("an org-wide role must not need a caseload");
      },
    });
    expect(scope).toBeNull();
  });

  it("is org-wide for the M22 scope-bypass roles the single-document predicate already honours", async () => {
    expect(await resolveDocumentListScope({ ...base, roles: ["survey_auditor"] })).toBeNull();
  });

  it("is org-wide, view-only, for a role granted documents.read_org_wide", async () => {
    const scope = await resolveDocumentListScope({ ...base, hasOrgWideKey: async () => true });
    expect(scope).toBeNull();
  });

  it("narrows a clinician without the key to their caseload", async () => {
    expect(await resolveDocumentListScope(base)).toEqual([P1]);
  });

  it("fails closed to an empty scope when the caseload cannot be resolved", async () => {
    const scope = await resolveDocumentListScope({
      ...base,
      resolveCaseload: async () => {
        throw new Error("CaseloadProvider unavailable");
      },
    });
    expect(scope).toEqual([]);
  });

  it("fails closed when the permission lookup throws, and reports it", async () => {
    const stages: string[] = [];
    const scope = await resolveDocumentListScope({
      ...base,
      hasOrgWideKey: async () => {
        throw new Error("resolver unavailable");
      },
      onLookupError: (stage) => stages.push(stage),
    });
    expect(scope).toEqual([P1]);
    expect(stages).toEqual(["org_wide_key"]);
  });

  it("reports a failed caseload lookup instead of swallowing it", async () => {
    const stages: string[] = [];
    await resolveDocumentListScope({
      ...base,
      resolveCaseload: async () => {
        throw new Error("CaseloadProvider unavailable");
      },
      onLookupError: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(["caseload"]);
  });

  describe("purpose: write (#641)", () => {
    const write = { ...base, purpose: "write" as const };

    it("the view-only documents.read_org_wide key does not widen a write", async () => {
      const scope = await resolveDocumentListScope({
        ...write,
        hasOrgWideKey: async () => {
          throw new Error("a write must not consult the view-only key");
        },
      });
      expect(scope).toEqual([P1]);
    });

    it.each(["survey_auditor", "qa"])(
      "%s is org-wide for a read but not for a write",
      async (role) => {
        expect(await resolveDocumentListScope({ ...base, roles: [role] })).toBeNull();
        expect(await resolveDocumentListScope({ ...write, roles: [role] })).toEqual([P1]);
      },
    );

    it.each(["compliance_officer", "medical_director", "org_admin", "director_of_nursing"])(
      "%s stays org-wide for a write",
      async (role) => {
        expect(await resolveDocumentListScope({ ...write, roles: [role] })).toBeNull();
      },
    );
  });
});
