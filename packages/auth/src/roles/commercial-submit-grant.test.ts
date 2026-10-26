// #817 — who may send a commercial claim. The decision (ADR-0100 D11): `commercial_billing.submit` follows `billing.claim.submit`
// (migration 1274 copied the grant from the Medicare analogue, which tenants assign to their claim-filing staff), and a fresh
// tenant gets it only through the templates below. This pins the template side: no clinical, auditor, read-only or platform role
// carries it out of the box.
import { describe, expect, it } from "vitest";
import { M41_CONTRIBUTED_PERMISSIONS } from "../permissions/contributed";
import { ROLE_TEMPLATES, rolesForPermission } from "./templates";

const SUBMIT = "commercial_billing.submit";

describe("commercial_billing.submit default grants", () => {
  it("is explicit on compliance_officer only; administrator and org_admin reach it through the catalog", () => {
    expect(rolesForPermission(SUBMIT)).toEqual(["compliance_officer"]);
  });

  it("is carried by no other template (clinical, auditor, family, volunteer, platform-ops, billing-adjacent)", () => {
    expect(ROLE_TEMPLATES.length).toBeGreaterThan(5);
    for (const t of ROLE_TEMPLATES.filter((r) => r.key !== "compliance_officer")) {
      expect([...(t.grants ?? []), ...t.floor], t.key).not.toContain(SUBMIT);
    }
  });

  it("the other four M41 keys are not widened by a template either (read/write/override stay with compliance_officer)", () => {
    for (const key of Object.keys(M41_CONTRIBUTED_PERMISSIONS)) {
      expect(rolesForPermission(key), key).toEqual(["compliance_officer"]);
    }
  });
});
