import type { ScreenRegistryModule } from "@wardenx/types";
// apps/admin/src/shell — the console's own login flow (M1 shell, ADR-0030), registered the same way
// as apps/web/src/shell/system-pages.tsx (moduleId: 1 — Foundation owns each app's shell), not as a
// numbered feature-module slice — there is no backend "Module 0" this corresponds to. Chromeless
// (outside RequireChrome's authenticated frame), since a signed-out actor must reach these.
import type { ComponentType } from "react";
import { Login } from "./login";
import { OrganizationSelect } from "./organization-select";

export const adminAuthScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 1,
  slug: "auth",
  screens: [
    { id: "auth.login", path: "/login", title: "Sign in", chrome: false, screen: Login },
    {
      id: "auth.organization-select",
      path: "/login/organization",
      title: "Select organization",
      chrome: false,
      screen: OrganizationSelect,
    },
  ],
};
