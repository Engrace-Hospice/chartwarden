/**
 * ADMIN-T02 — Platform-ops role catalog + M35 `billing_admin.*` bindings (§4.7).
 *
 * The six platform-ops roles gate M35's cross-tenant `/api/admin` surface via the `platform_billing_scope`
 * ABAC predicate. Before this task they existed only as a private string array in M35's `abac-predicates.ts`
 * and NO catalog role granted the seventeen `billing_admin.*` keys — so every key resolved to zero roles and
 * the whole §5.2 surface was 403-for-all. These tests pin: (1) the six templates are registered as
 * non-locked `platform_staff` roles; (2) every `billing_admin.*` key resolves to ≥1 role (no orphan); and
 * (3) the §4.7 binding rule (read → support/billing/admin/owner; write → billing/admin/owner; `refund.approve`
 * → admin/owner ONLY, disjoint from `refund.request` so §4.8 four-eyes stays assignable).
 */
import {
  M35_BILLING_ADMIN_READ_KEYS,
  M35_BILLING_ADMIN_WRITE_KEYS,
  M35_CONTRIBUTED_PERMISSIONS,
  M35_REFUND_APPROVE_KEY,
  PLATFORM_OPS_ROLE_GRANTS,
  PLATFORM_OPS_ROLE_KEYS,
  ROLE_TEMPLATES,
  platformOpsRolePermissionSeedRows,
  rolesForPermission,
} from "@wardenx/auth";
import { describe, expect, it } from "vitest";

/** The eighteen `billing_admin.*` keys are exactly the catalog entries in that category (source of truth).
 *  (M35A-T03 added `dunning.admin.read` — the dunning-list screen's read source — as the 18th, a READ key.) */
const BILLING_ADMIN_KEYS = Object.entries(M35_CONTRIBUTED_PERMISSIONS)
  .filter(([, def]) => def.category === "billing_admin")
  .map(([key]) => key);

const platformTemplates = ROLE_TEMPLATES.filter((t) =>
  PLATFORM_OPS_ROLE_KEYS.includes(t.key as never),
);

describe("ADMIN-T02 platform-ops role catalog (§4.7)", () => {
  it("registers exactly the six platform-ops roles as non-locked platform_staff templates", () => {
    expect(platformTemplates.map((t) => t.key).sort()).toEqual([...PLATFORM_OPS_ROLE_KEYS].sort());
    for (const t of platformTemplates) {
      expect(t.category).toBe("platform_staff");
      expect(t.systemLocked).toBe(false);
      expect(t.floor).toEqual([]); // non-locked → no CoP floor (grants live in `grants`, not the floor)
      expect(t.systemDefault).toBe(true);
    }
  });

  it("the M35 catalog exposes exactly eighteen `billing_admin.*` keys", () => {
    expect(BILLING_ADMIN_KEYS.length).toBe(18);
  });
});

describe("ADMIN-T02 `billing_admin.*` → role bindings (no orphan key)", () => {
  it("every `billing_admin.*` key resolves to ≥1 granting role", () => {
    for (const key of BILLING_ADMIN_KEYS) {
      expect(rolesForPermission(key).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("the union of all platform-ops grants is the seventeen `billing_admin.*` keys plus user lifecycle", () => {
    const granted = new Set(Object.values(PLATFORM_OPS_ROLE_GRANTS).flat());
    expect([...granted].sort()).toEqual([...BILLING_ADMIN_KEYS, "user.deactivate"].sort());
  });

  it("GAP-001: `user.deactivate` binds to platform_ops/admin/owner — the platform deactivate route's roles", () => {
    const holders = Object.entries(PLATFORM_OPS_ROLE_GRANTS)
      .filter(([, keys]) => keys.includes("user.deactivate"))
      .map(([role]) => role);
    expect(holders.sort()).toEqual(["platform_admin", "platform_ops", "platform_owner"]);
  });

  it("read keys bind to support/billing/admin/owner", () => {
    for (const key of M35_BILLING_ADMIN_READ_KEYS) {
      expect([...rolesForPermission(key)].sort()).toEqual(
        [
          "platform_admin",
          "platform_billing_admin",
          "platform_owner",
          "platform_support_t2",
        ].sort(),
      );
    }
  });

  it("mutating keys bind to billing/admin/owner (no support read-only role)", () => {
    for (const key of M35_BILLING_ADMIN_WRITE_KEYS) {
      expect([...rolesForPermission(key)].sort()).toEqual(
        ["platform_admin", "platform_billing_admin", "platform_owner"].sort(),
      );
    }
  });

  it("`refund.approve` binds to admin/owner ONLY — disjoint from `refund.request` (four-eyes assignable)", () => {
    expect([...rolesForPermission(M35_REFUND_APPROVE_KEY)].sort()).toEqual(
      ["platform_admin", "platform_owner"].sort(),
    );
    // The four-eyes rule (§4.8 `refund_requires_step_up_approval`) requires approver ≠ requester. A
    // `platform_billing_admin` may REQUEST but must NOT be able to self-APPROVE.
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_billing_admin).toContain("refund.request");
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_billing_admin).not.toContain("refund.approve");
  });

  it("`platform_sales` and `platform_ops` carry no default `billing_admin.*` grant this wave", () => {
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_sales).toEqual([]);
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_ops).toEqual(["user.deactivate"]);
  });
});

describe("ADMIN-T02 platform-ops grant seed", () => {
  it("flattens every role grant into well-formed `(roleKey, permissionKey)` rows", () => {
    const rows = platformOpsRolePermissionSeedRows();
    const expected = Object.values(PLATFORM_OPS_ROLE_GRANTS).reduce((n, g) => n + g.length, 0);
    expect(rows.length).toBe(expected);
    for (const row of rows) {
      expect(PLATFORM_OPS_ROLE_KEYS).toContain(row.roleKey);
      expect([...BILLING_ADMIN_KEYS, "user.deactivate"]).toContain(row.permissionKey);
    }
  });
});
