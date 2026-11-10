/**
 * GAP-003 — platform authority may never come from a tenant-owned role row.
 *
 * Every platform predicate (M22/M26/M29/M34/M35) decides on a role KEY in `context.roles`. Tenants can
 * create roles with any `^[a-z0-9_]+$` key, so a tenant row named `platform_admin` used to satisfy them.
 * These tests pin the single rule the enrichment reader, the role-create route and the DB backstop share.
 */
import {
  PLATFORM_ALERT_AUDIENCE_ROLE_KEY,
  PLATFORM_GRANTABLE_ROLE_KEYS,
  PLATFORM_OPS_ROLE_KEYS,
  ROLE_TEMPLATES,
  isPlatformGrantableRoleKey,
  isReservedPlatformRoleKey,
  isTenantRoleReserved,
  roleConfersKey,
} from "@chartwarden/auth";
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

describe("GAP-096 — ai_safety_owner is platform authority without the platform_ prefix", () => {
  it("reserves ai_safety_owner by exact key, not as a prefix", () => {
    expect(isReservedPlatformRoleKey("ai_safety_owner")).toBe(true);
    expect(isReservedPlatformRoleKey("ai_safety_owner_deputy")).toBe(false);
    // The single-tenant designee is a tenant role (gated in M32, not reserved here).
    expect(isReservedPlatformRoleKey("clinical_safety_lead")).toBe(false);
  });

  it("a tenant-owned ai_safety_owner row is refused at create and confers nothing", () => {
    expect(isTenantRoleReserved({ key: "ai_safety_owner", category: "clinical_staff" })).toBe(true);
    expect(
      roleConfersKey({ organizationId: "org_a", key: "ai_safety_owner", category: "operations" }),
    ).toBe(false);
    expect(
      roleConfersKey({ organizationId: null, key: "ai_safety_owner", category: "platform_staff" }),
    ).toBe(true);
  });
});

describe("platform-role CLI allowlist", () => {
  it("is exactly the platform keys a predicate reads, every one reserved", () => {
    expect([...PLATFORM_GRANTABLE_ROLE_KEYS].sort()).toEqual(
      [...PLATFORM_OPS_ROLE_KEYS, "platform_security_owner", "ai_safety_owner"].sort(),
    );
    for (const key of PLATFORM_GRANTABLE_ROLE_KEYS)
      expect(isReservedPlatformRoleKey(key)).toBe(true);
  });

  it("covers every platform-owned role template (a key list built from it never misses a holder)", () => {
    // `m34_platform_role_holders` selects exactly the keys the caller names (migration 1333 dropped the `platform_%` prefix floor
    // that 0740 / 1097 ANDed onto them), so the list callers use for "any platform staff" must contain every platform-owned role.
    // `platform_alert_audience` is the derived tenant binding, deliberately never a source of operators.
    const platformOwned = ROLE_TEMPLATES.filter((t) =>
      isTenantRoleReserved({ key: t.key, category: t.category }),
    )
      .map((t) => t.key)
      .filter((key) => key !== PLATFORM_ALERT_AUDIENCE_ROLE_KEY);
    expect(platformOwned.length).toBeGreaterThan(0);
    for (const key of platformOwned) expect(isPlatformGrantableRoleKey(key)).toBe(true);
    expect(PLATFORM_GRANTABLE_ROLE_KEYS as readonly string[]).not.toContain(
      PLATFORM_ALERT_AUDIENCE_ROLE_KEY,
    );
  });

  it("refuses unknown and tenant keys", () => {
    for (const key of ["platform_superuser", "org_admin", "clinical_safety_lead", ""]) {
      expect(isPlatformGrantableRoleKey(key)).toBe(false);
    }
    expect(isPlatformGrantableRoleKey("platform_ops")).toBe(true);
  });
});
