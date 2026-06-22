import type { ScreenDescriptor, ScreenRegistry, ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/shell — concrete React binding of the @wardenx/types screen registry (M1, ADR-0030).
import type { ComponentType } from "react";

/** A screen is a React component (no required props — it reads context/router params). */
export type WebScreen = ComponentType;
export type WebScreenDescriptor = ScreenDescriptor<WebScreen>;
export type WebScreenModule = ScreenRegistryModule<WebScreen>;

/** Create an empty screen registry. Module web-slices call registry.register(...) at composition. */
export function createScreenRegistry(): ScreenRegistry<WebScreen> {
  const modules: WebScreenModule[] = [];
  const ids = new Set<string>();
  return {
    register(module) {
      for (const s of module.screens) {
        if (ids.has(s.id))
          throw new Error(`duplicate screen id: "${s.id}" (module ${module.slug})`);
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
