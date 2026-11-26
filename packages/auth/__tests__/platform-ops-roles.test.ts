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
  M34_PLATFORM_OPS_ONBOARDING_KEYS,
  M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS,
  M35_BILLING_ADMIN_READ_KEYS,
  M35_BILLING_ADMIN_WRITE_KEYS,
  M35_CONTRIBUTED_PERMISSIONS,
  M35_PLATFORM_PRICING_OPERATOR_KEYS,
  M35_PRICING_READ_KEY,
  M35_REFUND_APPROVE_KEY,
  PLATFORM_BAA_STEWARD_KEYS,
  PLATFORM_DUTY_ROLE_KEYS,
  PLATFORM_GO_LIVE_APPROVER_KEYS,
  PLATFORM_ONBOARDING_DATA_KEYS,
  PLATFORM_ONBOARDING_READ_KEY,
  PLATFORM_ONBOARDING_ROLE_KEYS,
  PLATFORM_OPS_ROLE_GRANTS,
  PLATFORM_OPS_ROLE_KEYS,
  PLATFORM_ROLE_CONFLICTS,
  ROLE_TEMPLATES,
  platformOpsRolePermissionSeedRows,
  rolesForPermission,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";

/** The eighteen `billing_admin.*` keys are exactly the catalog entries in that category (source of truth).
 *  (M35A-T03 added `dunning.admin.read` — the dunning-list screen's read source — as the 18th, a READ key.) */
const BILLING_ADMIN_KEYS = Object.entries(M35_CONTRIBUTED_PERMISSIONS)
  .filter(([, def]) => def.category === "billing_admin")
  .map(([key]) => key);

/** Every permission key any platform-ops role carries by default. */
const ALL_PLATFORM_OPS_KEYS: readonly string[] = [
  ...BILLING_ADMIN_KEYS,
  "user.deactivate",
  "user.password.reset",
  ...M34_PLATFORM_OPS_ONBOARDING_KEYS,
  ...M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS,
  ...PLATFORM_BAA_STEWARD_KEYS,
  ...PLATFORM_GO_LIVE_APPROVER_KEYS,
  ...M35_PLATFORM_PRICING_OPERATOR_KEYS,
  M35_PRICING_READ_KEY,
  ...PLATFORM_ONBOARDING_DATA_KEYS,
];

const platformTemplates = ROLE_TEMPLATES.filter((t) =>
  [...PLATFORM_OPS_ROLE_KEYS, ...PLATFORM_DUTY_ROLE_KEYS].includes(t.key as never),
);

describe("ADMIN-T02 platform-ops role catalog (§4.7)", () => {
  it("registers exactly the six platform-ops roles and the three duty roles as non-locked platform_staff templates", () => {
    expect(platformTemplates.map((t) => t.key).sort()).toEqual(
      [...PLATFORM_OPS_ROLE_KEYS, ...PLATFORM_DUTY_ROLE_KEYS].sort(),
    );
    // the duty roles are NOT in the six-role admit-set every role-set predicate reads
    for (const role of PLATFORM_DUTY_ROLE_KEYS) {
      expect(PLATFORM_OPS_ROLE_KEYS as readonly string[]).not.toContain(role);
    }
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

  it("the union of all platform-ops grants includes billing, lifecycle and both M34 onboarding permission sets", () => {
    const granted = new Set(Object.values(PLATFORM_OPS_ROLE_GRANTS).flat());
    expect([...granted].sort()).toEqual([...new Set(ALL_PLATFORM_OPS_KEYS)].sort());
  });

  it("the operator's own wizard keys (manage, read, skip) bind to platform_ops, plus the wizard read to each duty role", () => {
    for (const key of M34_PLATFORM_OPS_ONBOARDING_KEYS) {
      const expected =
        key === PLATFORM_ONBOARDING_READ_KEY
          ? [...PLATFORM_ONBOARDING_ROLE_KEYS]
          : key === "platform_tenant_baa.read_platform"
            ? ["platform_ops", "platform_baa_steward"] // the operator reads the register beside the wizard; the steward keeps it
            : ["platform_ops"];
      expect([...rolesForPermission(key)].sort()).toEqual(expected.sort());
    }
  });

  it("CW-AC-22: BAA filing, go-live approval and pricing each bind to their own role and NOT to platform_ops", () => {
    // The approval is the approver's alone; the two reads its console panel loads are shared (checked in the next test).
    expect([...rolesForPermission("go_live.approve_platform")]).toEqual([
      "platform_go_live_approver",
    ]);
    for (const key of M35_PLATFORM_PRICING_OPERATOR_KEYS) {
      expect([...rolesForPermission(key)]).toEqual(["platform_pricing_operator"]);
    }
    expect(PLATFORM_BAA_STEWARD_KEYS).toEqual([
      "tenant_baa_document.upload_platform",
      "platform_tenant_baa.write_platform",
      "platform_tenant_baa.read_platform",
    ]);
    for (const key of PLATFORM_BAA_STEWARD_KEYS) {
      const expected =
        key === "platform_tenant_baa.read_platform"
          ? ["platform_baa_steward", "platform_ops"]
          : ["platform_baa_steward"];
      expect([...rolesForPermission(key)].sort(), key).toEqual(expected);
    }
    const ops = PLATFORM_OPS_ROLE_GRANTS.platform_ops;
    for (const key of [
      // platform_ops keeps the BAA register READ (the wizard's BAA panel), not the write or the upload
      ...PLATFORM_BAA_STEWARD_KEYS.filter((k) => k !== "platform_tenant_baa.read_platform"),
      "go_live.approve_platform",
      ...M35_PLATFORM_PRICING_OPERATOR_KEYS,
    ]) {
      expect(ops).not.toContain(key);
    }
  });

  it("CW-AC-22: the go-live approver holds the approval, the wizard read and the two reads its console panel loads, and nothing else; no duty role holds a billing_admin key", () => {
    expect([...PLATFORM_GO_LIVE_APPROVER_KEYS].sort()).toEqual([
      "go_live.approve_platform",
      "subscription.pricing_read_platform",
      "tenant_clearinghouse.read_platform",
    ]);
    expect([...PLATFORM_OPS_ROLE_GRANTS.platform_go_live_approver].sort()).toEqual(
      [...PLATFORM_GO_LIVE_APPROVER_KEYS, PLATFORM_ONBOARDING_READ_KEY].sort(),
    );
    for (const role of [
      "platform_baa_steward",
      "platform_go_live_approver",
      "platform_pricing_operator",
    ] as const) {
      for (const key of BILLING_ADMIN_KEYS) {
        expect(PLATFORM_OPS_ROLE_GRANTS[role]).not.toContain(key);
      }
      expect(PLATFORM_OPS_ROLE_GRANTS[role]).not.toContain("user.password.reset");
      expect(PLATFORM_OPS_ROLE_GRANTS[role]).not.toContain("user.deactivate");
    }
  });

  it("CW-AC-22: the go-live approver may not share an account with any other onboarding role, and every conflict names real roles", () => {
    expect(PLATFORM_ROLE_CONFLICTS.map(([a, b]) => [a, b].sort().join("+")).sort()).toEqual([
      "platform_baa_steward+platform_go_live_approver",
      "platform_go_live_approver+platform_ops",
      "platform_go_live_approver+platform_pricing_operator",
    ]);
    for (const pair of PLATFORM_ROLE_CONFLICTS) {
      for (const role of pair) {
        expect([...PLATFORM_OPS_ROLE_KEYS, ...PLATFORM_DUTY_ROLE_KEYS]).toContain(role);
      }
    }
  });

  it("slice 7: the support-session keys bind to platform_ops alone (the routes' predicates admit that role), never elevate", () => {
    for (const key of M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS) {
      expect([...rolesForPermission(key)]).toEqual(["platform_ops"]);
    }
    expect(rolesForPermission("support_session.elevate_phi_read")).toEqual([]);
  });

  it("slice 2: the pricing read key binds to platform_ops, the pricing operator, the go-live approver (its panel) and the three billing roles", () => {
    expect([...rolesForPermission(M35_PRICING_READ_KEY)].sort()).toEqual(
      [
        "platform_admin",
        "platform_billing_admin",
        "platform_go_live_approver",
        "platform_ops",
        "platform_owner",
        "platform_pricing_operator",
      ].sort(),
    );
    // a role whose predicate would deny the key never carries it
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_support_t2).not.toContain(M35_PRICING_READ_KEY);
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_sales).not.toContain(M35_PRICING_READ_KEY);
  });

  it("the platform onboarding-data pair binds only to platform_ops, matching the ABAC predicate", () => {
    for (const key of PLATFORM_ONBOARDING_DATA_KEYS) {
      // the clearinghouse READ is also the go-live approver's (CW-AC-22: its panel shows the choice before approval)
      const expected =
        key === "tenant_clearinghouse.read_platform"
          ? ["platform_go_live_approver", "platform_ops"]
          : ["platform_ops"];
      expect([...rolesForPermission(key)].sort()).toEqual(expected);
    }
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_admin).not.toContain(PLATFORM_ONBOARDING_DATA_KEYS[0]);
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_owner).not.toContain(PLATFORM_ONBOARDING_DATA_KEYS[1]);
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
    expect(PLATFORM_OPS_ROLE_GRANTS.platform_ops).toEqual([
      "user.deactivate",
      "user.password.reset",
      ...M34_PLATFORM_OPS_ONBOARDING_KEYS,
      ...M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS,
      M35_PRICING_READ_KEY,
      ...PLATFORM_ONBOARDING_DATA_KEYS,
    ]);
  });
});

describe("ADMIN-T02 platform-ops grant seed", () => {
  it("flattens every role grant into well-formed `(roleKey, permissionKey)` rows", () => {
    const rows = platformOpsRolePermissionSeedRows();
    const expected = Object.values(PLATFORM_OPS_ROLE_GRANTS).reduce((n, g) => n + g.length, 0);
    expect(rows.length).toBe(expected);
    for (const row of rows) {
      expect([...PLATFORM_OPS_ROLE_KEYS, ...PLATFORM_DUTY_ROLE_KEYS]).toContain(row.roleKey);
      expect(ALL_PLATFORM_OPS_KEYS).toContain(row.permissionKey);
    }
  });
});
