import type { ScreenRegistryModule } from "@chartwarden/types";
import { lazy } from "react";
import type { ComponentType } from "react";
const AppLanding = lazy(() => import("./app-landing").then((m) => ({ default: m.AppLanding })));

/**
 * `app.<base>` landing (ADR-0049 Phase 4), registered by main.tsx ONLY on that host: it claims `/`, which is the
 * chromed Role Home everywhere else. Kept out of screens.ts so the registry-driven smoke test (which globs the
 * per-module screens.ts files) never mounts it as a second `/`. Chromeless routes are matched before the chromed `/`, so it wins there.
 */
export const appLandingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 2,
  slug: "02-identity-app-landing",
  screens: [
    {
      id: "identity.app-landing",
      path: "/",
      title: "Find your organization",
      chrome: false, // pre-session, outside the app shell
      screen: AppLanding,
    },
  ],
};
