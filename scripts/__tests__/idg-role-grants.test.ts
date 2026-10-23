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
