// The nursing / physician / NP / PA roles open admissions (new or readmission) at their own site. These tests pin
// the default-grant table the backfill migration 0379 and the dev seed share, and the role-key list the M6
// `admission_clinical_site_scope` predicate keys off.
import { describe, expect, it } from "vitest";
import { allPermissionMirrorRows } from "../src/permissions/contributed";
import {
  ADMITTING_CLINICIAN_DEFAULT_GRANTS,
  ADMITTING_CLINICIAN_ROLE_KEYS,
  INTAKE_ROLE_KEYS,
  hasAdmittingClinicianRole,
} from "../src/roles";

describe("ADMITTING_CLINICIAN_DEFAULT_GRANTS", () => {
  it("grants exactly create + read + HETS read to every admitting clinician role", () => {
    expect(Object.keys(ADMITTING_CLINICIAN_DEFAULT_GRANTS).sort()).toEqual(
      [...ADMITTING_CLINICIAN_ROLE_KEYS].sort(),
    );
    for (const keys of Object.values(ADMITTING_CLINICIAN_DEFAULT_GRANTS))
      expect([...keys].sort()).toEqual([
        "admission.create",
        "admission.read",
        "billing.eligibility.read",
      ]);
  });

  it("names the nursing, physician, NP and PA roles the seeds and templates actually create", () => {
    for (const role of [
      "rn",
      "lpn",
      "rn_case_manager",
      "director_of_nursing",
      "md",
      "hospice_physician",
      "medical_director",
      "np",
      "pa",
    ])
      expect(ADMITTING_CLINICIAN_ROLE_KEYS, role).toContain(role);
  });

  it("never grants an external role, an intake role, or a live HETS check", () => {
    for (const role of ["physician_office", "portal_patient", "collaborator", "funeral_home"])
      expect(ADMITTING_CLINICIAN_ROLE_KEYS as readonly string[], role).not.toContain(role);
    for (const role of INTAKE_ROLE_KEYS)
      expect(ADMITTING_CLINICIAN_ROLE_KEYS as readonly string[], role).not.toContain(role);
    for (const keys of Object.values(ADMITTING_CLINICIAN_DEFAULT_GRANTS))
      expect(keys).not.toContain("billing.eligibility.check");
  });

  it("every granted key is a registered permission", () => {
    const registered = new Set(allPermissionMirrorRows().map((r) => r.key));
    for (const keys of Object.values(ADMITTING_CLINICIAN_DEFAULT_GRANTS))
      for (const key of keys) expect(registered.has(key), key).toBe(true);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ADMITTING_CLINICIAN_DEFAULT_GRANTS)).toBe(true);
  });
});

describe("hasAdmittingClinicianRole", () => {
  it("is true for any admitting clinician role and false otherwise", () => {
    expect(hasAdmittingClinicianRole(["rn"])).toBe(true);
    expect(hasAdmittingClinicianRole(["msw", "pa"])).toBe(true);
    expect(hasAdmittingClinicianRole(["physician_office"])).toBe(false);
    expect(hasAdmittingClinicianRole(["intake_supervisor", "billing_specialist"])).toBe(false);
    expect(hasAdmittingClinicianRole([])).toBe(false);
  });
});
