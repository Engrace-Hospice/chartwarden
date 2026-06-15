/**
 * M4-T10 — Module 4 permission-key registration into Module 3's catalog (the §4.5 binding
 * cross-module handshake). M4's audit/legal-hold/destruction routes are authorized BY M3, so
 * their permission keys must live in M3's catalog and mirror to the DB `permission` table.
 *
 * Accept (M4-T10): the nine §4.5 keys are registered, single-owner, `resource.action`
 * namespaced; `audit.disclosure_report_all_scopes` carries the `audit_accounting_scope_allowed`
 * ABAC predicate (M4-T09, §7.2) and is the ONLY ABAC-gated M4 key; the keys do not collide with
 * M3's locked catalog or the M1/M2 contributed set; and the six CoP-required `system_locked`
 * compliance roles still pin their load-bearing audit floor.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTED_PERMISSIONS,
  M4_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  m4ContributedPermissionMirrorRows,
} from "../src/permissions";
import { SYSTEM_LOCKED_FLOORS } from "../src/roles";

describe("M4-T10 audit permission keys (§4.5 handshake)", () => {
  it("registers exactly the nine §4.5 audit/legal-hold/destruction keys", () => {
    expect(Object.keys(M4_CONTRIBUTED_PERMISSIONS).sort()).toEqual(
      [
        "audit.read",
        "audit.disclosure_report",
        "audit.disclosure_report_all_scopes",
        "audit.export",
        "audit.integrity",
        "legalhold.read",
        "legalhold.manage",
        "destruction.read",
        "destruction.approve",
      ].sort(),
    );
  });

  it("keys are `resource.action` namespaced and reconstruct from resource/action", () => {
    for (const [key, def] of Object.entries(M4_CONTRIBUTED_PERMISSIONS)) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(key).toBe(`${def.resource}.${def.action}`);
    }
  });

  it("only `audit.disclosure_report_all_scopes` is ABAC-gated (`audit_accounting_scope_allowed`)", () => {
    expect(M4_CONTRIBUTED_PERMISSIONS["audit.disclosure_report_all_scopes"].abac).toBe(
      "audit_accounting_scope_allowed",
    );
    for (const [key, def] of Object.entries(M4_CONTRIBUTED_PERMISSIONS)) {
      if (key !== "audit.disclosure_report_all_scopes") expect(def.abac).toBe("none");
    }
  });

  it("does NOT collide with M3's locked catalog or the M1/M2 contributed set (single-owner)", () => {
    for (const key of Object.keys(M4_CONTRIBUTED_PERMISSIONS)) {
      expect(key in PERMISSIONS).toBe(false);
      expect(key in CONTRIBUTED_PERMISSIONS).toBe(false);
    }
  });

  it("projects one mirror row per M4 key for the DB `permission` table sync", () => {
    const rows = m4ContributedPermissionMirrorRows();
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(M4_CONTRIBUTED_PERMISSIONS).sort());
    for (const row of rows) {
      const def = M4_CONTRIBUTED_PERMISSIONS[row.key as keyof typeof M4_CONTRIBUTED_PERMISSIONS];
      expect(row.defaultAbac).toBe(def.abac);
      expect(row.category).toBe("compliance");
    }
  });

  it("every load-bearing floor key the compliance roles pin is now a registered M4 key", () => {
    // The M3-T02 locked floor names M4 keys before M4 existed; M4-T10 makes them real.
    const registered = new Set(Object.keys(M4_CONTRIBUTED_PERMISSIONS));
    const floorAuditKeys = Object.values(SYSTEM_LOCKED_FLOORS)
      .flat()
      .filter((k) => k.startsWith("audit.") || k.startsWith("legalhold."));
    for (const key of floorAuditKeys) expect(registered.has(key)).toBe(true);
  });
});
