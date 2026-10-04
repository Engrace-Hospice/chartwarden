/**
 * GAP-003 — platform authority may never come from a tenant-owned role row.
 *
 * Every platform predicate (M22/M26/M29/M34/M35) decides on a role KEY in `context.roles`. Tenants can
 * create roles with any `^[a-z0-9_]+$` key, so a tenant row named `platform_admin` used to satisfy them.
 * These tests pin the single rule the enrichment reader, the role-create route and the DB backstop share.
 */
import {
  PLATFORM_OPS_ROLE_KEYS,
  isReservedPlatformRoleKey,
  isTenantRoleReserved,
  roleConfersKey,
} from "@wardenx/auth";
import { describe, expect, it } from "vitest";

describe("GAP-003 reserved platform role keys", () => {
  it("reserves every platform-ops key and every platform_ key used by a predicate", () => {
    for (const key of [...PLATFORM_OPS_ROLE_KEYS, "platform_security_owner"]) {
      expect(isReservedPlatformRoleKey(key)).toBe(true);
    }
  });

  it("does not reserve ordinary tenant keys", () => {
    for (const key of ["org_admin", "rn", "weekend_float_rn", "platformer"]) {
      expect(isReservedPlatformRoleKey(key)).toBe(false);
    }
  });

  it("a tenant role is reserved when its key is platform_* or its category is platform_staff", () => {
    expect(isTenantRoleReserved({ key: "platform_admin", category: "operations" })).toBe(true);
    expect(isTenantRoleReserved({ key: "helpdesk", category: "platform_staff" })).toBe(true);
    expect(isTenantRoleReserved({ key: "helpdesk", category: "operations" })).toBe(false);
  });

  it("a tenant-owned row never confers a reserved key; a platform-owned (org NULL) row does", () => {
    const tenantRow = { organizationId: "org_a", key: "platform_admin", category: "operations" };
    const platformRow = { organizationId: null, key: "platform_admin", category: "platform_staff" };
    expect(roleConfersKey(tenantRow)).toBe(false);
    expect(roleConfersKey(platformRow)).toBe(true);
    expect(roleConfersKey({ organizationId: "org_a", key: "rn", category: "clinical_staff" })).toBe(
      true,
    );
  });
});
