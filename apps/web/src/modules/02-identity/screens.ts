// apps/web/src/modules/02-identity — M2 screen registration (Track A, ADR-0030).
// Declares this module's screens for the M1 shell registry. Typed against the @wardenx/types
// contract (no shell import); the composition root (apps/web/src/main.tsx) registers it.
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { AcceptInvitation } from "./accept-invitation";
import { OrganizationSelect } from "./organization-select";
import { SignIn } from "./sign-in";

export const identityScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 2,
  slug: "02-identity",
  screens: [
    {
      id: "identity.sign-in",
      path: "/login",
      title: "Sign in",
      chrome: false, // Auth Flow — outside the app shell
      screen: SignIn,
    },
    {
      id: "identity.organization-select",
      path: "/login/organization",
      title: "Select organization",
      chrome: false, // Auth Flow — outside the app shell
      screen: OrganizationSelect,
    },
    {
      id: "identity.accept-invitation",
      path: "/invite/:token",
      title: "Accept invitation",
      chrome: false,
      screen: AcceptInvitation,
    },
  ],
};
