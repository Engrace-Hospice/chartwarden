import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/40-mdm — M40 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const MdmConsole = lazy(() => import("./mdm-console").then((m) => ({ default: m.MdmConsole })));

export const mdmScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 40,
  slug: "40-mdm",
  screens: [
    {
      id: "mdm.console",
      path: "/mdm",
      title: "Master Data",
      // GAP-116 — the console reads the clinical-directory kinds; physician is the one every directory reader holds.
      requiredPermission: "mdm.physician.read",
      navGroup: "Admin",
      screen: MdmConsole,
    },
  ],
};
