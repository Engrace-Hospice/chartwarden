import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/38-terminology — M38 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const TerminologyAdmin = lazy(() =>
  import("./terminology-admin").then((m) => ({ default: m.TerminologyAdmin })),
);

export const terminologyScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 38,
  slug: "38-terminology",
  screens: [
    {
      id: "terminology.admin",
      path: "/terminology",
      title: "Terminology",
      requiredPermission: "terminology.read", // GAP-116 — the console only runs the search read (terminology.admin.read gates the load-status surface, not built here)
      navGroup: "Admin",
      screen: TerminologyAdmin,
    },
  ],
};
