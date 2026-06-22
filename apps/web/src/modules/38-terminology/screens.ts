import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/38-terminology — M38 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import { TerminologyAdmin } from "./terminology-admin";

export const terminologyScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 38,
  slug: "38-terminology",
  screens: [
    {
      id: "terminology.admin",
      path: "/terminology",
      title: "Terminology",
      navGroup: "Admin",
      screen: TerminologyAdmin,
    },
  ],
};
