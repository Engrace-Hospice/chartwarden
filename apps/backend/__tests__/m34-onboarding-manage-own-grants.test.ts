/**
 * `onboarding.manage_own` is gated twice: the permission (requirePermission) and the ABAC predicate
 * `tenant_org_admin_role`, which admits the LITERAL role key `org_admin`. Migration 1329 also granted the key to
 * `administrator`, a grant that passed the first check and was refused at the second (an administrator-only member got 403).
 * Migration 1461 revokes it; the role-template planner withholds it from `administrator`. This pins the invariant the
 * review asked for: the roles a fresh tenant materializes WITH the key are exactly the ones the predicate admits, so no
 * grant is dead and none is missing. It does not change who is authorized.
 */
import {
  ADMINISTRATOR_EXCLUDED_KEYS,
  type AbacContext,
  ROLE_TEMPLATES,
  allPermissionMirrorRows,
  planRoleTemplateMaterialization,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { buildTenantPlatformAbacPredicates } from "../src/modules/34-saas-tenant-platform/abac-predicates";
import { actorMayActOnStep } from "../src/modules/34-saas-tenant-platform/onboarding/wizard-core";

const KEY = "onboarding.manage_own";
const mirror = allPermissionMirrorRows().map((r) => ({ key: r.key, category: r.category }));
const plan = planRoleTemplateMaterialization({
  templates: ROLE_TEMPLATES,
  existingRoleKeys: new Set(),
  mirror,
});

const predicate = buildTenantPlatformAbacPredicates({
  resolver: {} as never,
  isInCaseload: async () => false,
}).tenant_org_admin_role as (
  context: AbacContext,
  target: Record<string, unknown>,
) => Promise<boolean>;

const contextFor = (role: string): AbacContext =>
  ({ organizationId: "org", userId: "u", roles: [role], attributes: {} }) as unknown as AbacContext;

describe("onboarding.manage_own grants match what tenant_org_admin_role admits", () => {
  it("is in the permission mirror (the grant set below is not vacuously empty)", () => {
    expect(mirror.some((p) => p.key === KEY)).toBe(true);
  });

  it("a freshly materialized tenant grants the key to exactly the roles the predicate admits", async () => {
    const holders = plan.filter((r) => r.permissionKeys.includes(KEY)).map((r) => r.key);
    const admitted: string[] = [];
    for (const role of plan) {
      if (await predicate(contextFor(role.key), {})) admitted.push(role.key);
    }
    expect(holders.sort()).toEqual(admitted.sort());
    expect(holders).toEqual(["org_admin"]);
  });

  it("administrator is withheld the key while org_admin keeps it and every other full-catalog key", () => {
    const orgAdmin = plan.find((r) => r.key === "org_admin")?.permissionKeys ?? [];
    const administrator = plan.find((r) => r.key === "administrator")?.permissionKeys ?? [];
    expect(orgAdmin).toContain(KEY);
    expect(administrator).not.toContain(KEY);
    expect(administrator).toEqual(orgAdmin.filter((k) => !ADMINISTRATOR_EXCLUDED_KEYS.has(k)));
  });

  it("the wizard's own check agrees: only org_admin may act on an org_admin step", () => {
    const tenant = (role: string) => ({ kind: "tenant", roles: [role] }) as never;
    expect(actorMayActOnStep(tenant("org_admin"), "org_admin")).toBe(true);
    expect(actorMayActOnStep(tenant("administrator"), "org_admin")).toBe(false);
  });

  it("migration 1461 revokes only the administrator grant, from tenant-owned roles only", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../../../packages/db/migrations");
    const sql = readFileSync(
      join(dir, "1461_m34_revoke_dead_onboarding_manage_own_from_administrator.sql"),
      "utf8",
    );
    expect(sql).toMatch(/^-- compat: contract/);
    expect(sql).toMatch(/r\."key" = 'administrator'/);
    expect(sql).toMatch(/rp\."permission_key" = 'onboarding\.manage_own'/);
    expect(sql).toMatch(/r\."organization_id" IS NOT NULL/);
    expect(sql).not.toMatch(/'org_admin'/);
  });
});
