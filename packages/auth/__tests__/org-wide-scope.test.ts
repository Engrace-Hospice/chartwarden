// F-096 — the ONE derivation of "which roles read the whole org's patients without a caseload".
//
// This list existed five times before this file: M7's care-plan predicates, M8's encounter predicates,
// M9's assessment predicates, M10's HOPE predicates and M15's disclosure gate. Three of the five omitted
// `director_of_nursing`. F-092 had already found that omission and fixed it BY DERIVING the list from
// the CoP floors — in one file, leaving four literals behind, two of which still carried the bug it had
// just diagnosed.
//
// These tests pin the derivation, not a literal. Asserting the four names would recreate the thing that
// failed: a hand-maintained list that agrees with the floors until someone edits one of them.
import { SYSTEM_LOCKED_FLOORS } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { ORG_WIDE_SCOPE_ROLES, hasOrgWideScope } from "../src/roles/org-wide-scope";

describe("ORG_WIDE_SCOPE_ROLES is derived from the CoP floors", () => {
  it("contains every system_locked role whose floor locks patient.read", () => {
    // The invariant, stated as the derivation rather than as its current output. A new CoP-required
    // role that locks `patient.read` joins the list with no edit anywhere; one that stops locking it
    // leaves. That is the property the five literals did not have.
    const floored = Object.entries(SYSTEM_LOCKED_FLOORS)
      .filter(([, floor]) => (floor as readonly string[]).includes("patient.read"))
      .map(([role]) => role);
    expect(floored.length).toBeGreaterThan(0);
    for (const role of floored) expect(ORG_WIDE_SCOPE_ROLES).toContain(role);
  });

  it("includes director_of_nursing — the role three of the five copies omitted", () => {
    // CoP 418.64(a) makes the DON responsible for all nursing services, and the floor locks
    // `patient.read` AND `patient.assign` onto the role: a permission to put clinicians on caseloads
    // that cannot be exercised against patients the holder may not see. M8, M9 and M10 refused this
    // role every encounter, assessment and HOPE record outside its own caseload.
    expect(hasOrgWideScope(["director_of_nursing"])).toBe(true);
  });

  it("keeps the three oversight roles that carry no patient.read floor", () => {
    // `compliance_officer` and `survey_coordinator` are org-wide by ROLE rather than by floor —
    // `survey_coordinator` is not in SYSTEM_LOCKED_FLOORS at all — so the derivation is a union, not a
    // replacement. Dropping them would have been a silent narrowing sold as a refactor.
    for (const role of ["medical_director", "compliance_officer", "survey_coordinator"]) {
      expect(hasOrgWideScope([role])).toBe(true);
    }
  });

  it("includes administrator and org_admin — the tenant-admin roles, org-wide by ADR-0090", () => {
    // ADR-0090 reverses the earlier exclusion. Neither role carries a `patient.read` floor, so like the
    // oversight names they are org-wide by ROLE, not by derivation: the platform owner decided a
    // tenant administrator (CoP 418.100) and the tenant-admin business role read every patient in the
    // org. Pinned by name so a later narrowing is a visible test change, not a silent refactor.
    for (const role of ["administrator", "org_admin"]) {
      expect(hasOrgWideScope([role])).toBe(true);
    }
  });

  it("is false for a clinical role, an empty set, and an unknown name", () => {
    expect(hasOrgWideScope(["rn"])).toBe(false);
    expect(hasOrgWideScope([])).toBe(false);
    expect(hasOrgWideScope(["not_a_role"])).toBe(false);
  });

  it("is stable and de-duplicated — medical_director is both an oversight name and a floored one", () => {
    expect([...ORG_WIDE_SCOPE_ROLES]).toEqual([...new Set(ORG_WIDE_SCOPE_ROLES)]);
    expect([...ORG_WIDE_SCOPE_ROLES]).toEqual([...ORG_WIDE_SCOPE_ROLES].sort());
  });
});
