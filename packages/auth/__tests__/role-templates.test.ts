/**
 * M3-T02 — Roles, joins + `system_locked` floor (M3 spec §3.4, §3.4.1, M03-F06).
 *
 * Accept criterion: "unit test for the locked floor." The floor is the minimum
 * permission set a CoP-required `system_locked` role must always retain; the role editor
 * (§2.4 / PATCH /roles/:id, M3-T08) rejects any edit that would strip below it. These
 * tests pin the six normatively-specified locked roles + their floors and prove the
 * floor-enforcement helpers (`floorViolations` / `satisfiesFloor`) reject stripping but
 * allow extension.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_TEMPLATES,
  SYSTEM_LOCKED_FLOORS,
  type SystemLockedRoleKey,
  floorFor,
  floorViolations,
  isSystemLocked,
  satisfiesFloor,
} from "../src/roles";

describe("M3-T02 system_locked role floor (spec §3.4.1)", () => {
  it("enumerates exactly the six CoP-required locked roles", () => {
    expect(Object.keys(SYSTEM_LOCKED_FLOORS).sort()).toEqual(
      [
        "administrator",
        "compliance_officer",
        "director_of_nursing",
        "hipaa_privacy_officer",
        "hipaa_security_officer",
        "medical_director",
      ].sort(),
    );
  });

  it("pins each role's required permission floor verbatim (§3.4.1 table)", () => {
    expect(SYSTEM_LOCKED_FLOORS.medical_director).toEqual([
      "patient.read",
      "cti.sign",
      "idg.participate",
      "order.cosign",
      "breakglass.invoke",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.director_of_nursing).toEqual([
      "patient.read",
      "care_plan.manage",
      "idg.participate",
      "assignment.manage",
      "breakglass.invoke",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.administrator).toEqual([
      "org.manage",
      "member.manage",
      "role.read",
      "report.read",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.compliance_officer).toEqual([
      "audit.read",
      "audit.disclosure_report",
      "breakglass.read",
      "breakglass.cosign",
      "engagement.manage",
      "legalhold.manage",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.hipaa_privacy_officer).toEqual([
      "audit.read",
      "audit.disclosure_report",
      "consent.read",
      "legalhold.read",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.hipaa_security_officer).toEqual([
      "audit.read",
      "audit.integrity",
      "security_event.read",
    ]);
  });

  it("every floor permission is `resource.action` namespaced and non-empty", () => {
    for (const floor of Object.values(SYSTEM_LOCKED_FLOORS)) {
      expect(floor.length).toBeGreaterThan(0);
      for (const key of floor) expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe("M3-T02 role catalog ↔ floor consistency", () => {
  it("every locked template carries systemLocked + its matching floor; defaults carry none", () => {
    for (const tmpl of ROLE_TEMPLATES) {
      if (tmpl.systemLocked) {
        expect(isSystemLocked(tmpl.key)).toBe(true);
        expect(tmpl.floor).toEqual(SYSTEM_LOCKED_FLOORS[tmpl.key as SystemLockedRoleKey]);
        expect(tmpl.floor.length).toBeGreaterThan(0);
      } else {
        expect(tmpl.floor).toEqual([]);
      }
    }
  });

  it("ships a template for every locked-floor key", () => {
    const lockedTemplateKeys = ROLE_TEMPLATES.filter((t) => t.systemLocked).map((t) => t.key);
    expect(lockedTemplateKeys.sort()).toEqual(Object.keys(SYSTEM_LOCKED_FLOORS).sort());
  });
});

describe("M3-T02 floor enforcement helpers (§2.4)", () => {
  it("floorFor returns the floor for locked roles and [] for anything else", () => {
    expect(floorFor("compliance_officer")).toEqual(SYSTEM_LOCKED_FLOORS.compliance_officer);
    expect(floorFor("registered_nurse")).toEqual([]);
    expect(isSystemLocked("registered_nurse")).toBe(false);
  });

  it("rejects an edit that strips a floor permission (returns the missing keys)", () => {
    const stripped = SYSTEM_LOCKED_FLOORS.administrator.filter((k) => k !== "org.manage");
    expect(floorViolations("administrator", stripped)).toEqual(["org.manage"]);
    expect(satisfiesFloor("administrator", stripped)).toBe(false);
  });

  it("accepts an edit that retains the floor and adds extra permissions (rename/extend ok)", () => {
    const extended = [...SYSTEM_LOCKED_FLOORS.administrator, "report.export", "dashboard.read"];
    expect(floorViolations("administrator", extended)).toEqual([]);
    expect(satisfiesFloor("administrator", extended)).toBe(true);
  });

  it("a non-locked role never violates the floor (empty floor)", () => {
    expect(floorViolations("registered_nurse", [])).toEqual([]);
    expect(satisfiesFloor("registered_nurse", [])).toBe(true);
  });
});
