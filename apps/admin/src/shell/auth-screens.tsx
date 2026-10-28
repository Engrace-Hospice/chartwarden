import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/admin/src/shell — the console's own login flow (M1 shell, ADR-0030), registered the same way
// as apps/web/src/shell/system-pages.tsx (moduleId: 1 — Foundation owns each app's shell), not as a
// numbered feature-module slice — there is no backend "Module 0" this corresponds to. Chromeless
// (outside RequireChrome's authenticated frame), since a signed-out actor must reach these.
import { lazy } from "react";
import type { ComponentType } from "react";

// Lazy so the better-auth client (~45 kB) stays out of the entry (#849); the shell wraps routes in <Suspense>.
const Login = lazy(() => import("./login").then((m) => ({ default: m.Login })));
const OrganizationSelect = lazy(() =>
  import("./organization-select").then((m) => ({ default: m.OrganizationSelect })),
);
const AdminStepUp = lazy(() => import("./step-up").then((m) => ({ default: m.AdminStepUp })));

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
    // Re-verify the CURRENT session for a step-up-gated action (403 STEP_UP_REQUIRED), then return.
    {
      id: "auth.step-up",
      path: "/step-up",
      title: "Confirm it’s you",
      chrome: false,
      screen: AdminStepUp,
    },
  ],
};
