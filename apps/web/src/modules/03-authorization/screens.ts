// apps/web/src/modules/03-authorization — M3 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { RolesPermissions } from "./roles-permissions";

export const authorizationScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 3,
  slug: "03-authorization",
  screens: [
    {
      id: "authz.roles-permissions",
      path: "/roles",
      title: "Roles & Permissions",
      navGroup: "Admin",
      requiredPermission: "role.read",
      screen: RolesPermissions,
    },
  ],
};
