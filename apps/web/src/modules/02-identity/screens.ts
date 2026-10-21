// F-081 (#91) — STEP-UP WAS UNSATISFIABLE BY ANY USER, IN ANY DEPLOYMENT, UNTIL NOW.
//
// The platform gates 138 route guards across 23 modules on `requireStepUp`, resolved from
// `session.last_step_up_at`. F-029 found that the routes which WRITE that column were mounted by
// nobody and fixed it. Nothing then asked whether the FACTOR those routes require can be ENROLLED. It
// could not, for three independent reasons, each of them alone fatal, and none of them visible from any
// layer below a real browser — which is why `e2e/specs/idg.spec.ts`, driving the D13 IDG adjourn
// through a Chromium virtual authenticator, is what found all three:
//
//   1. `resolvePasskeyOrigin()` returned `BETTER_AUTH_URL` — the AUTH SERVER's base URL — where
//      WebAuthn's `expectedOrigin` is the origin of the PAGE that ran the ceremony, i.e. this SPA.
//      Its `http://localhost:5173` fallback shows the intent; production REQUIRES `BETTER_AUTH_URL`,
//      so any deployment not serving the SPA same-origin refused every registration. It resolves from
//      `TRUSTED_ORIGINS` + `baseURL` now — the list the CSRF layer already trusts, because an origin
//      the browser may call this API from is exactly an origin a ceremony may run on.
//   2. `passkey.name` was NOT NULL with no default (migration 0234 drops it). Better Auth treats the
//      name as optional and inserts the column default when absent; `security-passkeys.tsx` sends one
//      only if the user types into an optional field, and its own list renders `name ?? "Passkey"` —
//      it was written against a nullable column. Leaving the field blank raised 23502 and
//      `verify-registration` answered 500 "Passkey registration failed or was cancelled", which blames
//      the user's device for a schema constraint.
//   3. The step-up challenge was minted as a 32-character HEX string and handed to
//      `navigator.credentials.get` as the challenge BYTES. An authenticator echoes the challenge back
//      base64url-encoded inside `clientDataJSON`, and @simplewebauthn compares that to
//      `expectedChallenge` verbatim — so the server checked `163779f8…` against `MTYzNzc5Zjg…` and
//      rejected every assertion this platform could produce as `webauthn_verification_failed`: a real
//      passkey, correctly signed, reported as a forgery. It is base64url on both sides now, the shape
//      Better Auth's own `/passkey/generate-register-options` already returns.
//
// And two that made the ceremony unusable rather than impossible: a 401 from the step-up VERIFY route
// (a factor that did not verify) was read by the shell as session death, bouncing the user to
// `/expired` on their FIRST wrong code — which made the route's own three-attempt lockout counter
// unreachable; and `/step-up/initiate` advertised an RP id from `WEBAUTHN_RP_ID` while the verifier
// checked `PASSKEY_RP_ID`, two required production vars for one fact with nothing comparing them.
//
// STILL MISSING, and stated because it is the reason a single defect here was total: THERE IS NO TOTP
// ENROLMENT SURFACE. `mfa-challenge.tsx` verifies a TOTP code at sign-in for an enrolled user, and
// nothing in any front-end calls `authClient.twoFactor.enable` to create that enrolment. The Better
// Auth plugin is configured and the step-up route accepts the factor, so this is a missing SCREEN, not
// a missing mechanism — but until it exists, `/security/passkeys` is the platform's only path to a
// second factor, and a browser or device without WebAuthn has none.
import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/02-identity — M2 screen registration (Track A, ADR-0030).
// Declares this module's screens for the M1 shell registry. Typed against the @chartwarden/types
// contract (no shell import); the composition root (apps/web/src/main.tsx) registers it.
import { lazy } from "react";
import type { ComponentType } from "react";
const AcceptInvitation = lazy(() =>
  import("./accept-invitation").then((m) => ({ default: m.AcceptInvitation })),
);
const AcceptTenantInvitation = lazy(() =>
  import("./accept-tenant-invitation").then((m) => ({ default: m.AcceptTenantInvitation })),
);
const AuditorRedeem = lazy(() =>
  import("./auditor-redeem").then((m) => ({ default: m.AuditorRedeem })),
);
const AuditorEnrolment = lazy(() =>
  import("./auditor-enrolment").then((m) => ({ default: m.AuditorEnrolment })),
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
const RequiredPasswordChange = lazy(() =>
  import("./required-password-change").then((m) => ({ default: m.RequiredPasswordChange })),
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
      id: "identity.required-password-change",
      path: "/login/change-password",
      title: "Change your password",
      chrome: false,
      screen: RequiredPasswordChange,
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
      // M34 first-admin invitation (`tenant_invitation`): the provisioning email links here, not to /invite/:token,
      // whose M2 peek only knows `organization_invitation`. Pre-session, so no app chrome.
      id: "identity.accept-tenant-invitation",
      path: "/tenant-invite/:token",
      title: "Accept invitation",
      chrome: false,
      screen: AcceptTenantInvitation,
    },
    {
      id: "identity.auditor-redeem",
      path: "/auditor/redeem",
      title: "Auditor access",
      chrome: false, // Auth Flow — an emailed link opens it before any session exists
      screen: AuditorRedeem,
    },
    {
      id: "identity.auditor-enrolment",
      path: "/auditor/enrol",
      title: "Auditor enrolment",
      chrome: false, // Auth Flow — the constrained session may reach nothing else until this is done
      screen: AuditorEnrolment,
    },
    {
      // The same passkey screen, outside the shell: a first org_admin must register a passkey BEFORE the server will
      // bind an org, and the shell's pre-org guard bounces every chrome screen back to /login/organization.
      id: "identity.passkey-enrolment",
      path: "/login/passkey",
      title: "Register a passkey",
      chrome: false,
      screen: SecurityPasskeys,
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
