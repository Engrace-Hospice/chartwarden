/**
 * M3-T11 — Role × action matrix (M3 spec §9.2; Security Hardening §6 mandates this).
 *
 * "For a representative set of resources, assert every default role gets its expected
 * allows and is denied everything else." This proves the catalog-driven authorization
 * model at the resolver layer: each `system_locked` CoP role, granted exactly its
 * §3.4.1 floor, resolves to an effective permission set that ALLOWS every floor key and
 * DENIES every sampled action outside it — no role silently confers an out-of-floor
 * permission. It exercises the same `resolveEffectivePermissions` fold the live RBAC
 * engine uses (M3-T06), so the matrix is a faithful (not parallel) check.
 *
 * Scope: the six floor-bearing `system_locked` templates this task ships (the ≈60
 * `system_default` templates carry an empty floor — Appendix A, CI-checked elsewhere).
 */
import { ROLE_TEMPLATES, type RoleTemplate, resolveEffectivePermissions } from "@wardenx/auth";
import { describe, expect, it } from "vitest";

/**
 * A representative cross-section of sensitive actions spanning the role categories — the
 * "every default role is denied everything else" axis. Every key here is a real permission
 * key some role legitimately holds; the matrix asserts a role is denied the ones NOT in its
 * own floor, so a single missed RBAC scoping shows up as an unexpected allow.
 */
const SAMPLED_ACTIONS = [
  "org.manage",
  "org.delete",
  "member.manage",
  "role.manage",
  "patient.read",
  "cti.sign",
  "care_plan.manage",
  "order.cosign",
  "idg.participate",
  "assignment.manage",
  "audit.read",
  "audit.integrity",
  "audit.disclosure_report",
  "breakglass.invoke",
  "breakglass.cosign",
  "engagement.manage",
  "legalhold.manage",
  "security_event.read",
] as const;

/** Resolve a role's effective set from exactly its floor (one permanent, enabled grant). */
function effectiveOf(template: RoleTemplate): ReadonlySet<string> {
  return resolveEffectivePermissions(
    [{ roleKey: template.key, enabled: true, expiresAt: null, permissionKeys: template.floor }],
    0,
  ).permissions;
}

const LOCKED = ROLE_TEMPLATES.filter((t) => t.systemLocked);

describe("M3-T11 role × action matrix (§9.2) — system_locked CoP roles", () => {
  it("ships the six floor-bearing system_locked templates", () => {
    expect(LOCKED.map((t) => t.key).sort()).toEqual(
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

  describe.each(LOCKED)("$key", (template) => {
    const effective = effectiveOf(template);

    it("ALLOWS every CoP-floor permission (the role grants what it must)", () => {
      for (const key of template.floor) expect(effective.has(key)).toBe(true);
    });

    it("DENIES every sampled action outside its floor (no out-of-floor escalation)", () => {
      const floor = new Set(template.floor);
      for (const action of SAMPLED_ACTIONS) {
        if (floor.has(action)) continue;
        expect(effective.has(action)).toBe(false);
      }
    });
  });

  it("no two locked roles collapse to the same effective set (catalog is non-degenerate)", () => {
    const fingerprints = LOCKED.map((t) => [...effectiveOf(t)].sort().join("|"));
    expect(new Set(fingerprints).size).toBe(LOCKED.length);
  });

  it("a disabled grant of any role confers nothing (matrix all-deny when role disabled)", () => {
    for (const template of LOCKED) {
      const off = resolveEffectivePermissions(
        [
          {
            roleKey: template.key,
            enabled: false,
            expiresAt: null,
            permissionKeys: template.floor,
          },
        ],
        0,
      ).permissions;
      expect(off.size).toBe(0);
    }
  });
});
