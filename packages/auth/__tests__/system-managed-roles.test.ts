/**
 * Slice 2 — `external_auditor` is the role M3's auditor grant creates inside a tenant org. A tenant may not create a role under that key
 * (the M3 route and the database refuse it), because a real auditor must always land on the SYSTEM row and the M35 staff meter tells
 * that row from a look-alike. These tests pin the list and keep it clear of what the role-template materializer writes.
 */
import {
  EXTERNAL_AUDITOR_ROLE_KEY,
  ROLE_TEMPLATES,
  SYSTEM_MANAGED_ROLE_KEYS,
  isSystemManagedRoleKey,
  isTenantRoleReserved,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

describe("system-managed role keys", () => {
  it("are the keys the system creates inside a tenant org on demand: external_auditor", () => {
    expect(EXTERNAL_AUDITOR_ROLE_KEY).toBe("external_auditor");
    expect([...SYSTEM_MANAGED_ROLE_KEYS]).toEqual(["external_auditor"]);
    expect(isSystemManagedRoleKey("external_auditor")).toBe(true);
  });

  it("match by exact key only", () => {
    for (const key of [
      "external_auditor_liaison",
      "auditor",
      "external-auditor",
      "EXTERNAL_AUDITOR",
      "registered_nurse",
    ]) {
      expect(isSystemManagedRoleKey(key), key).toBe(false);
    }
  });

  it("the role-template path never writes one: no template carries a system-managed key, so the materializer cannot create a look-alike", () => {
    expect(ROLE_TEMPLATES.filter((t) => isSystemManagedRoleKey(t.key))).toEqual([]);
  });

  it("is NOT folded into the platform reservation (tenant-owned system rows must keep conferring their key): the real org-owned role is not 'tenant-reserved'", () => {
    // isTenantRoleReserved drives the enrichment reader's roleConfersKey: a tenant-owned row it flags confers nothing, and the REAL
    // org-owned external_auditor row must keep resolving for the auditor it was made for.
    expect(isTenantRoleReserved({ key: "external_auditor", category: "external_auditor" })).toBe(
      false,
    );
  });
});
