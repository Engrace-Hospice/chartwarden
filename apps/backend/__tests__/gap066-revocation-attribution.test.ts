// GAP-066: the staff revoke route must derive actor class server-side. A staff session claiming
// `patient_self_via_portal` must not skip the >=40-char reason + evidence document rule.
import { validateRevocation } from "@wardenx/consent";
import { ChartWardenError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { deriveStaffRevocationAttribution } from "../src/modules/39-consent/routes/consent-route-support";

describe("deriveStaffRevocationAttribution", () => {
  it("treats every accepted kind as a staff-initiated revocation (full validation applies)", () => {
    for (const kind of ["staff", "dpoa_agent", "court_order"] as const) {
      const out = deriveStaffRevocationAttribution(kind);
      expect(out.actorIsStaff).toBe(true);
      expect(out.revokedByKind).toBe(kind);
    }
  });

  it("rejects a claimed patient_self_via_portal on the staff route", () => {
    expect(() => deriveStaffRevocationAttribution("patient_self_via_portal")).toThrow(ChartWardenError);
  });

  it("rejects platform_admin_break_glass on the staff route", () => {
    expect(() => deriveStaffRevocationAttribution("platform_admin_break_glass")).toThrow(
      ChartWardenError,
    );
  });

  it("keeps the 40-char reason + evidence rule for a dpoa_agent/court_order claim", () => {
    const { actorIsStaff } = deriveStaffRevocationAttribution("court_order");
    const decision = validateRevocation({ actorIsStaff, reasonText: "", evidenceDocumentId: null });
    expect(decision.ok).toBe(false);
  });
});
