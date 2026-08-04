import type { ScreenRegistryModule } from "@wardenx/types";
import { describe, expect, it } from "vitest";
// @wardenx/admin — ADMIN-T01 shell registry-host unit test. Guards the contract every platform-module
// slice depends on: createAdminRegistry() starts empty, merges registered slices' screens, exposes the
// registered modules, and throws on a duplicate screen id (a collision would silently shadow a surface).
// The per-slice manifest↔component binding test lives with each slice (M35A-T04); this guards the host.
import type { AdminScreen } from "../src/shell/registry";
import { createAdminRegistry } from "../src/shell/registry";

const Noop: AdminScreen = () => null;

function moduleOf(
  slug: string,
  moduleId: number,
  ids: string[],
): ScreenRegistryModule<AdminScreen> {
  return {
    moduleId,
    slug,
    screens: ids.map((id) => ({ id, path: `/${id}`, title: id, screen: Noop })),
  };
}

describe("admin shell registry (M34 ADMIN-T01)", () => {
  it("starts empty", () => {
    const registry = createAdminRegistry();
    expect(registry.screens()).toHaveLength(0);
    expect(registry.modules()).toHaveLength(0);
  });

  it("merges the screens of registered slices", () => {
    const registry = createAdminRegistry();
    registry.register(moduleOf("35-subscription-billing", 35, ["m35.plans", "m35.refunds"]));
    expect(registry.screens().map((s) => s.id)).toEqual(["m35.plans", "m35.refunds"]);
  });

  it("exposes the registered modules", () => {
    const registry = createAdminRegistry();
    registry.register(moduleOf("35-subscription-billing", 35, ["m35.plans"]));
    const modules = registry.modules();
    expect(modules).toHaveLength(1);
    expect(modules[0]?.slug).toBe("35-subscription-billing");
    expect(modules[0]?.moduleId).toBe(35);
  });

  it("throws on a duplicate screen id across slices", () => {
    const registry = createAdminRegistry();
    registry.register(moduleOf("35-subscription-billing", 35, ["m35.plans"]));
    expect(() => registry.register(moduleOf("99-other", 99, ["m35.plans"]))).toThrow(
      /duplicate admin screen id/,
    );
  });

  it("returns a defensive copy of the module list", () => {
    const registry = createAdminRegistry();
    registry.register(moduleOf("35-subscription-billing", 35, ["m35.plans"]));
    registry.modules().length = 0;
    expect(registry.modules()).toHaveLength(1);
  });
});
