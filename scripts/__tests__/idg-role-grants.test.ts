import { describe, expect, it } from "vitest";
import { roleMayHoldPermission } from "../db/lib/idg-role-grants";

describe("roleMayHoldPermission (M14 default roles for idg.coordinate / idg.schedule)", () => {
  it.each([
    "volunteer",
    "volunteer_coordinator",
    "chha",
    "lpn",
    "rn",
    "rn_case_manager",
    "np",
    "msw",
    "chaplain",
    "clinician",
    "compliance_officer",
  ])("withholds both IDG keys from %s", (role) => {
    expect(roleMayHoldPermission(role, "idg.coordinate")).toBe(false);
    expect(roleMayHoldPermission(role, "idg.schedule")).toBe(false);
  });

  it.each(["clinical_supervisor", "medical_director"])("grants both IDG keys to %s", (role) => {
    expect(roleMayHoldPermission(role, "idg.coordinate")).toBe(true);
    expect(roleMayHoldPermission(role, "idg.schedule")).toBe(true);
  });

  it("leaves every other key alone, including the keys attendees need", () => {
    expect(roleMayHoldPermission("volunteer", "idg.attend")).toBe(true);
    expect(roleMayHoldPermission("rn", "idg.decide")).toBe(true);
    expect(roleMayHoldPermission("rn", "patient.read")).toBe(true);
  });
});

describe("roleMayHoldPermission (M8 encounter.administrative_override, the draft-visit void gate)", () => {
  it.each(["rn", "rn_case_manager", "lpn", "chha", "chaplain", "volunteer", "md", "np", "auditor"])(
    "withholds the void gate from %s",
    (role) => {
      expect(roleMayHoldPermission(role, "encounter.administrative_override")).toBe(false);
    },
  );

  it("keeps it for the clinical supervisor", () => {
    expect(roleMayHoldPermission("clinical_supervisor", "encounter.administrative_override")).toBe(
      true,
    );
  });
});

describe("roleMayHoldPermission (M8 visit-note closure keys, ADR-0113 D7)", () => {
  const OVERRIDE = "encounter.closure_override";
  const POLICY_ADMIN = "encounter.closure_policy_admin";
  const NOT_SUPERVISORS = [
    "rn",
    "registered_nurse",
    "lpn",
    "chha",
    "home_health_aide",
    "chaplain",
    "volunteer",
    "msw",
    "md",
    "np",
    "auditor",
    "compliance_officer",
  ];

  it.each(NOT_SUPERVISORS)("withholds both closure keys from %s", (role) => {
    expect(roleMayHoldPermission(role, OVERRIDE)).toBe(false);
    expect(roleMayHoldPermission(role, POLICY_ADMIN)).toBe(false);
  });

  it.each(["clinical_supervisor", "director_of_nursing", "don", "clinical_lead"])(
    "keeps the override for the supervisor key %s",
    (role) => {
      expect(roleMayHoldPermission(role, OVERRIDE)).toBe(true);
    },
  );

  it("gives the policy key to the DON keys only, never the field supervisors", () => {
    expect(roleMayHoldPermission("director_of_nursing", POLICY_ADMIN)).toBe(true);
    expect(roleMayHoldPermission("don", POLICY_ADMIN)).toBe(true);
    expect(roleMayHoldPermission("clinical_supervisor", POLICY_ADMIN)).toBe(false);
    expect(roleMayHoldPermission("clinical_lead", POLICY_ADMIN)).toBe(false);
  });
});

describe("roleMayHoldPermission (M19 triage.paper_reentry, #640)", () => {
  it.each(["auditor", "clinician", "rn", "volunteer"])(
    "withholds the back-dating write from %s",
    (role) => {
      expect(roleMayHoldPermission(role, "triage.paper_reentry")).toBe(false);
    },
  );

  it.each(["clinical_supervisor", "compliance_officer"])("keeps it for %s", (role) => {
    expect(roleMayHoldPermission(role, "triage.paper_reentry")).toBe(true);
  });
});
