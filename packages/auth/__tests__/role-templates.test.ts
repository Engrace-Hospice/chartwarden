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
  rolesForPermission,
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

  /**
   * F-093 — pinned to the KEYS THE PERMISSION CATALOG REGISTERS, not to §3.4.1's table.
   *
   * These assertions used to quote the spec table verbatim, and eight of the twenty-seven entries were
   * names no module ever registered (`cti.sign` where M6 registers `cti.sign_hospice_md`, `order.cosign`
   * where M11 registers `orders.cosign`, `security_event.read` for a resource with no table, no route
   * and no key anywhere in the platform). Pinning the spec is what kept them: the test passed for as
   * long as the floor stayed wrong, and would have failed the moment anyone corrected it.
   *
   * `catalog.ts` states the rule this now follows — "the permission catalog is CODE, the single source
   * of truth" — and §3.4.1 lives in a module spec, which the authority rule makes an implementation
   * proposal. It is not a cosmetic disagreement: `role_permission.permission_key` REFERENCES
   * `permission.key`, so a floor key with no catalog row cannot be granted at all, and
   * `floorViolations` reports an ungrantable key as stripped on every edit — an unsatisfiable floor
   * makes a locked role permanently uneditable once §3.4.1 is actually enforced.
   * `permission-catalog.test.ts` pins the resolution invariant itself; this pins the chosen mapping.
   */
  it("pins each role's required permission floor verbatim (catalog-resolved)", () => {
    expect(SYSTEM_LOCKED_FLOORS.medical_director).toEqual([
      "patient.read",
      "cti.sign_hospice_md", // 42 CFR 418.22(c)(1) splits the CTI signature; this is the hospice-MD arm
      "idg.attend",
      "orders.cosign",
      "breakglass.invoke",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.director_of_nursing).toEqual([
      "patient.read",
      "care_plan.finalize",
      "idg.attend",
      "patient.assign", // CoP 418.64(a)'s "assigns nursing staff to patients"
      "breakglass.invoke",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.administrator).toEqual([
      "org.manage",
      "member.manage",
      "role.read",
      "report.dashboard.read",
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
      "privacy.admin",
    ]);
    expect(SYSTEM_LOCKED_FLOORS.hipaa_security_officer).toEqual([
      "audit.read",
      "audit.integrity",
      // §164.308(a)(1)(ii)(D)/(a)(6) is audit review PLUS security-incident tracking; M30's
      // `incident.*` surface is that. No `security_event` resource exists anywhere in the platform.
      "incident.read",
    ]);
  });

  it("every floor permission is dot-namespaced and non-empty", () => {
    // Two segments MINIMUM, not exactly two: the catalog has carried three-segment keys since M33
    // (`report.dashboard.read`) and M37 (`m37.bed.assign`). The old `^[a-z_]+\.[a-z_]+$` was a second
    // reason the floor could not name a real key — it would have rejected the correct one (F-093).
    for (const floor of Object.values(SYSTEM_LOCKED_FLOORS)) {
      expect(floor.length).toBeGreaterThan(0);
      for (const key of floor) expect(key).toMatch(/^[a-z_0-9]+(\.[a-z_0-9]+)+$/);
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
    // M5 §4.7 — `privacy.admin` is the privacy officer's floor and the compliance officer's default grant;
    // org_admin holds it by neither (M5 §6: org_admin cannot resync privacy flags).
    expect(rolesForPermission("privacy.admin")).toEqual([
      "compliance_officer",
      "hipaa_privacy_officer",
    ]);
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

describe("WP 5.8 (ADR-0087) break-glass keys reach NEW tenants' roles (migration 1140 only covers existing ones)", () => {
  const grantsOf = (key: string) => ROLE_TEMPLATES.find((t) => t.key === key)?.grants ?? [];

  it("the compliance officer reviews; the physician and the supervisory nurse invoke", () => {
    expect(grantsOf("compliance_officer")).toContain("messaging.break_glass.review");
    expect(grantsOf("medical_director")).toContain("messaging.break_glass.invoke");
    expect(grantsOf("director_of_nursing")).toContain("messaging.break_glass.invoke");
  });

  it("no template grants both: the person who invokes is not the one who reviews by default", () => {
    for (const t of ROLE_TEMPLATES) {
      const g = t.grants ?? [];
      const both =
        g.includes("messaging.break_glass.invoke") && g.includes("messaging.break_glass.review");
      expect(both, t.key).toBe(false);
    }
  });
});

describe("WP 5.7 (ADR-0089) export keys reach NEW tenants' compliance officer and no clinical template", () => {
  const EXPORT_KEYS = [
    "messaging.export.request",
    "messaging.export.approve",
    "messaging.export.download",
  ];

  it("the compliance_officer template grants all three (migration 1147 only covers existing roles)", () => {
    const grants = ROLE_TEMPLATES.find((t) => t.key === "compliance_officer")?.grants ?? [];
    for (const k of EXPORT_KEYS) expect(grants).toContain(k);
  });

  it("only the compliance_officer template grants any export key by default", () => {
    for (const t of ROLE_TEMPLATES) {
      if (t.key === "compliance_officer") continue;
      for (const k of EXPORT_KEYS) expect(t.grants ?? [], `${t.key} ${k}`).not.toContain(k);
    }
  });
});

describe("WP 5.6 (ADR-0086) messaging.retention.manage reaches NEW tenants' compliance officer", () => {
  it("the compliance_officer template grants it by default (migration 1138 only covers existing roles)", () => {
    const template = ROLE_TEMPLATES.find((t) => t.key === "compliance_officer");
    expect(template?.grants).toContain("messaging.retention.manage");
  });
});
