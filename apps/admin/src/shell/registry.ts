import type { ScreenDescriptor, ScreenRegistry, ScreenRegistryModule } from "@wardenx/types";
// apps/admin/src/shell — concrete screen registry for the Platform-Ops console (M34, ADR-0030). The
// admin analogue of apps/web/src/shell/screen-registry.ts + apps/portal's registry: an empty registry
// the composition root (main.tsx) registers each platform-module slice into. The shell reads the merged
// screen set to build its router + nav rail, so it NEVER imports a module slice directly (the frontend
// analogue of M1's seam registry — architecture wins over the M35 spec's "M35 owns apps/admin" layout).
import type { ComponentType } from "react";

/** An admin screen is a React component (no required props — it reads context/router params). */
export type AdminScreen = ComponentType;
export type AdminScreenDescriptor = ScreenDescriptor<AdminScreen>;
export type AdminScreenModule = ScreenRegistryModule<AdminScreen>;

/**
 * Create an empty admin screen registry. Platform-module slices call `registry.register(...)` at
 * composition; registration throws on a duplicate screen id so a collision surfaces at boot rather
 * than silently shadowing a surface.
 */
export function createAdminRegistry(): ScreenRegistry<AdminScreen> {
  const modules: AdminScreenModule[] = [];
  const ids = new Set<string>();
  return {
    register(module) {
      for (const s of module.screens) {
        if (ids.has(s.id))
          throw new Error(`duplicate admin screen id: "${s.id}" (module ${module.slug})`);
        ids.add(s.id);
      }
      modules.push(module);
    },
    modules() {
      return [...modules];
    },
    screens() {
      return modules.flatMap((m) => m.screens);
    },
  };
}
