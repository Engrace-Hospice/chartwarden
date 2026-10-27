import { describe, expect, it } from "vitest";
import { SYSTEM_ROLE_DISPLAY_NAMES, systemRoleDisplayName } from "./display-names";
import { ROLE_TEMPLATES } from "./templates";

describe("system role display names", () => {
  it("maps each clinical system key to its reviewed, distinct label", () => {
    expect(SYSTEM_ROLE_DISPLAY_NAMES).toEqual({
      rn: "Registered Nurse (RN)",
      rn_case_manager: "RN Case Manager",
      lpn: "Licensed Practical Nurse (LPN)",
      lvn: "Licensed Vocational Nurse (LVN)",
      md: "Physician (MD/DO)",
      hospice_physician: "Hospice Physician",
      medical_director: "Hospice Medical Director",
      np: "Nurse Practitioner",
      msw: "Medical Social Worker",
      chaplain: "Chaplain",
      volunteer: "Volunteer",
      volunteer_coordinator: "Volunteer Coordinator",
      clinical_supervisor: "Clinical Supervisor",
      compliance_officer: "Compliance Officer",
      chha: "Home Health Aide",
      hipaa_privacy_officer: "HIPAA Privacy Officer",
    });
    expect(new Set(Object.values(SYSTEM_ROLE_DISPLAY_NAMES)).size).toBe(
      Object.keys(SYSTEM_ROLE_DISPLAY_NAMES).length,
    );
    expect(ROLE_TEMPLATES.find((role) => role.key === "medical_director")?.name).toBe(
      "Hospice Medical Director",
    );
  });

  it("fails closed for an unregistered system role", () => {
    expect(() => systemRoleDisplayName("unreviewed_role")).toThrow(
      "No canonical display name is registered",
    );
  });
});
