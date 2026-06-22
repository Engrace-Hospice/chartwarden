import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/40-mdm — M40 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import { MdmConsole } from "./mdm-console";

export const mdmScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 40,
  slug: "40-mdm",
  screens: [
    {
      id: "mdm.console",
      path: "/mdm",
      title: "Master Data",
      navGroup: "Admin",
      screen: MdmConsole,
    },
  ],
};
