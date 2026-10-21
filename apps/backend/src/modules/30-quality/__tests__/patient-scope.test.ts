// GAP-091 — the M30 PHI patient scope: server-derived, fail-closed, and applied in SQL.
import { NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  assertPatientInScope,
  resolveQualityPatientScope,
  scopeAllowsPatient,
} from "../routes/patient-scope";

const ORG = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222221";
const P2 = "22222222-2222-4222-8222-222222222222";

const actor = (roles: readonly string[]) => ({ organizationId: ORG, userId: "u1", roles });

describe("resolveQualityPatientScope", () => {
  it("gives an org-wide role the org scope without consulting the caseload seam", async () => {
    let called = false;
    const scope = await resolveQualityPatientScope(actor(["medical_director"]), () => {
      called = true;
      throw new Error("must not be called");
    });
    expect(scope).toEqual({ kind: "org" });
    expect(called).toBe(false);
  });

  it("scopes everyone else to exactly their caseload", async () => {
    const scope = await resolveQualityPatientScope(actor(["rn_case_manager"]), () => ({
      caseloadPatientIds: async () => [P1, P2],
    }));
    expect(scope).toEqual({ kind: "caseload", patientIds: [P1, P2] });
  });

  it("fails CLOSED (empty caseload) when the seam lookup rejects", async () => {
    const scope = await resolveQualityPatientScope(actor(["rn_case_manager"]), () => ({
      caseloadPatientIds: async () => {
        throw new Error("seam down");
      },
    }));
    expect(scope).toEqual({ kind: "caseload", patientIds: [] });
  });

  it("fails CLOSED when resolving the seam itself throws (deny-stub / unbound)", async () => {
    const scope = await resolveQualityPatientScope(actor([]), () => {
      throw new Error("seam not bound");
    });
    expect(scope).toEqual({ kind: "caseload", patientIds: [] });
  });
});

describe("scopeAllowsPatient / assertPatientInScope", () => {
  it("org scope allows any patient and a patient-less row", () => {
    expect(scopeAllowsPatient({ kind: "org" }, P1)).toBe(true);
    expect(scopeAllowsPatient({ kind: "org" }, null)).toBe(true);
  });

  it("caseload scope allows only listed patients", () => {
    const scope = { kind: "caseload", patientIds: [P1] } as const;
    expect(scopeAllowsPatient(scope, P1)).toBe(true);
    expect(scopeAllowsPatient(scope, P2)).toBe(false);
  });

  it("a patient-less row (visitor/staff) and an own record are not narrowed by the caseload", () => {
    const scope = { kind: "caseload", patientIds: [] } as const;
    expect(scopeAllowsPatient(scope, null)).toBe(true);
    expect(scopeAllowsPatient(scope, P2, true)).toBe(true);
    expect(scopeAllowsPatient(scope, P2, false)).toBe(false);
  });

  it("denies with a 404 (not 403) so existence is not disclosed", () => {
    const scope = { kind: "caseload", patientIds: [P1] } as const;
    expect(() => assertPatientInScope(scope, P2, "incident")).toThrow(NotFoundError);
    expect(() => assertPatientInScope(scope, undefined, "incident")).not.toThrow();
    expect(() => assertPatientInScope(scope, P1, "incident")).not.toThrow();
  });
});
