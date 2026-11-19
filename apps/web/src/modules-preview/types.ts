// What a module contributes to modules-preview: its real screen registry, the fixtures behind it, and where to start.
import type { ScreenRegistryModule } from "@chartwarden/types";
import type { ComponentType } from "react";
import type { Fixtures } from "./mock-client";

export interface ModulePreview {
  screens: ScreenRegistryModule<ComponentType>;
  fixtures: Fixtures;
  /** The route the harness opens when the URL names only the module. */
  start: string;
  /** Permissions the screens gate buttons on, beyond each screen's own `requiredPermission`. */
  extraPermissions: string[];
}
