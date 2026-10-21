import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/03-authorization — M3 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const RolesPermissions = lazy(() =>
  import("./roles-permissions").then((m) => ({ default: m.RolesPermissions })),
);

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
