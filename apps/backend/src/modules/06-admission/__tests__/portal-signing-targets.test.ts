import { describe, expect, it } from "vitest";
import { createPortalSigningTargetCheck } from "../portal-signing-targets";

const base = { organizationId: "org-1", patientId: "pat-1", targetRef: "t-1" } as const;

function check(over: {
  statement?: { state: string } | null;
  scopePatient?: string | null;
  admissionPatient?: string | null;
  nor?: { id: string } | null;
}) {
  return createPortalSigningTargetCheck(
    {
      getElectionStatement: async () => (over.statement ?? null) as never,
      getAdmission: async () =>
        over.admissionPatient ? ({ patientId: over.admissionPatient } as never) : null,
      getNor: async () => (over.nor ?? null) as never,
    },
    {
      loadElectionStatementScope: async () =>
        over.scopePatient ? { patientId: over.scopePatient } : null,
    },
  );
}

describe("createPortalSigningTargetCheck", () => {
  const election = { ...base, docKind: "election_statement" } as const;
  const nor = { ...base, docKind: "notice_of_patient_rights" } as const;

  it("accepts a drafted election statement of this patient", async () => {
    expect(await check({ statement: { state: "drafted" }, scopePatient: "pat-1" })(election)).toBe(
      true,
    );
  });
  it("refuses a signed, absent or another patient's election statement", async () => {
    expect(await check({ statement: { state: "signed" }, scopePatient: "pat-1" })(election)).toBe(
      false,
    );
    expect(await check({})(election)).toBe(false);
    expect(await check({ statement: { state: "drafted" }, scopePatient: "pat-2" })(election)).toBe(
      false,
    );
  });
  it("accepts this patient's admission until its notice is acknowledged", async () => {
    expect(await check({ admissionPatient: "pat-1" })(nor)).toBe(true);
    expect(await check({ admissionPatient: "pat-1", nor: { id: "n-1" } })(nor)).toBe(false);
  });
  it("refuses an absent or another patient's admission", async () => {
    expect(await check({})(nor)).toBe(false);
    expect(await check({ admissionPatient: "pat-2" })(nor)).toBe(false);
  });
});
