import { allPermissionMirrorRows } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
// apps/admin/src/modules/23-billing-medicare — the M23 platform-admin screen registry (the same guard the M35 admin
// slice carries): the screen binds a component, and its `requiredPermission` is a REAL packages/auth key — the one
// POST /api/v1/admin/billing/wage-indexes/load gates on.
import { medicareBillingAdminScreens } from "../screens";

const CATALOG_KEYS = new Set(allPermissionMirrorRows().map((r) => r.key));

describe("M23 platform-admin screen registry", () => {
  it("declares the module as M23 / 23-billing-medicare", () => {
    expect(medicareBillingAdminScreens.moduleId).toBe(23);
    expect(medicareBillingAdminScreens.slug).toBe("23-billing-medicare");
  });

  it("registers the wage-index load, bound to a component, on the route's own permission", () => {
    const [load] = medicareBillingAdminScreens.screens;
    expect(medicareBillingAdminScreens.screens).toHaveLength(1);
    expect(load?.screen, "must bind a (lazy) component").toBeTruthy();
    expect(load?.path).toBe("/admin/billing/wage-indexes/load");
    expect(load?.requiredPermission).toBe("billing.rule_config.platform_admin");
    expect(CATALOG_KEYS.has("billing.rule_config.platform_admin")).toBe(true);
  });
});
