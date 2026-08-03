import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/02-identity — M2 screen registration (Track A, ADR-0030).
// Declares this module's screens for the M1 shell registry. Typed against the @wardenx/types
// contract (no shell import); the composition root (apps/web/src/main.tsx) registers it.
import { lazy } from "react";
import type { ComponentType } from "react";
const AcceptInvitation = lazy(() =>
  import("./accept-invitation").then((m) => ({ default: m.AcceptInvitation })),
);
const ForgotPassword = lazy(() =>
  import("./forgot-password").then((m) => ({ default: m.ForgotPassword })),
);
const MfaChallenge = lazy(() =>
  import("./mfa-challenge").then((m) => ({ default: m.MfaChallenge })),
);
const OrganizationSelect = lazy(() =>
  import("./organization-select").then((m) => ({ default: m.OrganizationSelect })),
);
const ResetPassword = lazy(() =>
  import("./reset-password").then((m) => ({ default: m.ResetPassword })),
);
const SecurityPasskeys = lazy(() =>
  import("./security-passkeys").then((m) => ({ default: m.SecurityPasskeys })),
);
const SignIn = lazy(() => import("./sign-in").then((m) => ({ default: m.SignIn })));
const StaffManagement = lazy(() =>
  import("./staff-management").then((m) => ({ default: m.StaffManagement })),
);
const StepUp = lazy(() => import("./step-up").then((m) => ({ default: m.StepUp })));

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
      id: "identity.mfa-challenge",
      path: "/login/2fa",
      title: "Two-factor",
      chrome: false,
      screen: MfaChallenge,
    },
    {
      id: "identity.forgot-password",
      path: "/forgot",
      title: "Reset password",
      chrome: false, // Auth Flow — outside the app shell
      screen: ForgotPassword,
    },
    {
      id: "identity.reset-password",
      path: "/reset-password",
      title: "Set a new password",
      chrome: false,
      screen: ResetPassword,
    },
    {
      id: "identity.step-up",
      path: "/step-up",
      title: "Confirm it’s you",
      chrome: false, // Auth Flow — a single focused re-verification, outside the app shell
      screen: StepUp,
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
    {
      // Authenticated settings screen — register/manage WebAuthn passkeys.
      id: "identity.security-passkeys",
      path: "/security/passkeys",
      title: "Passkeys",
      navGroup: "General",
      screen: SecurityPasskeys,
    },
    {
      // Admin — org member roster, invitations, and member lifecycle.
      id: "identity.staff-management",
      path: "/admin/staff",
      title: "Staff Management",
      navGroup: "Admin",
      requiredPermission: "member.manage",
      screen: StaffManagement,
    },
  ],
};
