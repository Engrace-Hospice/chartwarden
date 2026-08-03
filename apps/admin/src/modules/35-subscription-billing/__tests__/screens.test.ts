import { allPermissionMirrorRows } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
// apps/admin/src/modules/35-subscription-billing — M35A-T04 screen-registry unit test (the ADR-0030 substitute
// for arch:ui-parity + arch:frame-fidelity, which scan apps/web ONLY and are blind to apps/admin). Guards the
// wiring the §5.2 console depends on: every manifest entry binds to a real component, ids and routes are
// unique (a collision would silently shadow a screen), each `requiredPermission` resolves to a REAL key in
// the packages/auth catalog (a typo'd key would sit as a permanently-hidden — or worse, mis-gated — screen),
// and the slice carries no internal id/path collision (the shell's own fail-fast throw-on-duplicate is an
// M34-owned contract, covered by apps/admin/__tests__/admin-shell.test.ts — the M35 slice must not import
// the M34 shell registry directly, ADR-0025: M34↔M35 is seam-both-ways with no edge either direction).
import { subscriptionAdminScreens } from "../screens";

/** The set of every permission key the M3 catalog actually registers (M35's §4.7 keys included). */
const CATALOG_KEYS = new Set(allPermissionMirrorRows().map((r) => r.key));

describe("M35 §5.2 admin screen registry (M35A-T04)", () => {
  it("declares the module as M35 / 35-subscription-billing", () => {
    expect(subscriptionAdminScreens.moduleId).toBe(35);
    expect(subscriptionAdminScreens.slug).toBe("35-subscription-billing");
  });

  it("registers the fourteen §5.2 screens, each bound to a component", () => {
    expect(subscriptionAdminScreens.screens).toHaveLength(14);
    for (const s of subscriptionAdminScreens.screens) {
      expect(typeof s.screen, `${s.id} must bind a component`).toBe("function");
    }
  });

  it("has unique screen ids", () => {
    const ids = subscriptionAdminScreens.screens.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique route paths", () => {
    const paths = subscriptionAdminScreens.screens.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gates every screen on a REAL packages/auth permission key (no typo'd / never-registered key)", () => {
    for (const s of subscriptionAdminScreens.screens) {
      expect(s.requiredPermission, `${s.id} must name a permission key`).toBeDefined();
      expect(CATALOG_KEYS.has(s.requiredPermission as string), `${s.id} → "${s.requiredPermission}" is not a catalog key`).toBe(true);
    }
  });

  it("gates every §5.2 screen on a `billing_admin`-category key (the platform-ops surface)", () => {
    const billingAdmin = new Set(allPermissionMirrorRows().filter((r) => r.category === "billing_admin").map((r) => r.key));
    for (const s of subscriptionAdminScreens.screens) {
      expect(billingAdmin.has(s.requiredPermission as string), `${s.id} must gate on a billing_admin key`).toBe(true);
    }
  });

  it("carries no id/path that collides with itself (the shell throws on cross-slice dup ids)", () => {
    const ids = subscriptionAdminScreens.screens.map((s) => s.id);
    const paths = subscriptionAdminScreens.screens.map((s) => s.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    // Every id is namespaced under `admin.` so it cannot collide with another platform module's slice.
    for (const id of ids) expect(id.startsWith("admin.")).toBe(true);
  });
});
