// apps/web/src/shell — what the shell knows about an organization that is still being onboarded, declared once for everyone who needs
// it (the app shell's watcher, the background pollers, and the onboarding gate in modules/34-saas/wizard).
//
// While `organizationStage` is "onboarding" the server confines the session to an allowlist of exact `METHOD /template` pairs
// (apps/backend/src/bootstrap/onboarding-org-gate.ts, PRE_ACTIVATION_ALLOWED_ROUTES) and answers every other route 403
// ORGANIZATION_ONBOARDING. The screens below are the chromed screens whose own calls are all on that allowlist; add a screen here
// only after its calls are:
//   /admin/onboarding*      the tenant wizard (GET /tenant/onboarding and the step, org-profile, officer and go-live writes ...)
//   /admin/account          GET /api/v1/tenant/account
//   /admin/setup            provider entities and locations (M2 org-admin routes)
//   /security/passkeys      the vendor auth catch-all `/api/auth/*`: the step-up ceremony sends a person with no enrolled factor here
//                           (StepUpCard `enrolPasskeyPath`), and without it a new compliance officer could never finish a step-up.
// The server is the authority; this only decides what the shell offers.
import type { Session } from "./session-types";

/** The tenant onboarding wizard: where the landing page, and a refused call from a session of unknown stage, send the person. */
export const ONBOARDING_HOME = "/admin/onboarding";

/** The chromed screens that work while the organization is onboarding (see the pairing note above). */
export const ONBOARDING_SCREENS: readonly string[] = [
  ONBOARDING_HOME,
  "/admin/account",
  "/admin/setup",
  "/security/passkeys",
];

export const isOnboardingScreen = (path: string): boolean =>
  ONBOARDING_SCREENS.some((screen) => path === screen || path.startsWith(`${screen}/`));

/** True when the session says its organization is still onboarding. An absent stage is unknown, never "onboarding". */
export const isOnboardingSession = (session: Pick<Session, "organizationStage"> | null): boolean =>
  session?.organizationStage === "onboarding";
