// apps/web/src/modules/34-saas/wizard — the shell's onboarding gate. While the organization is still being onboarded the server refuses
// every route outside onboarding, go-live, account and sign-in (403 ORGANIZATION_ONBOARDING), so a screen that calls anything else could
// only fail. This guard sends the landing page to the wizard and says "Available after go-live" on the other chromed screens instead.
// It acts only when the session says `organizationStage === "onboarding"`; an absent stage is unknown, and the shell stays normal (the
// server is the authority either way). Injected into the shell by main.tsx, so the shell imports no feature module.
import { EmptyState } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { Link, Navigate } from "react-router-dom";
import { useSession } from "../../../shell/session";

/** The wizard itself: where the landing page and a refused call send the person. */
export const ONBOARDING_HOME = "/admin/onboarding";

/** The chromed screens that work while onboarding: the wizard, the account page and Agency setup (their routes are on the server's allowlist). */
const ONBOARDING_SCREENS: readonly string[] = [ONBOARDING_HOME, "/admin/account", "/admin/setup"];

const isOnboardingScreen = (path: string): boolean =>
  ONBOARDING_SCREENS.some((screen) => path === screen || path.startsWith(`${screen}/`));

export function OnboardingScreenGate({
  path,
  children,
}: {
  /** The registered path of the screen being shown ("/" for the landing page). */
  path: string;
  children: ReactNode;
}): JSX.Element {
  const stage = useSession()?.organizationStage;
  if (stage !== "onboarding") return <>{children}</>;
  if (path === "/") return <Navigate to={ONBOARDING_HOME} replace />;
  if (isOnboardingScreen(path)) return <>{children}</>;
  return (
    <EmptyState
      title="Available after go-live"
      description="This part of ChartWarden opens once your organization has finished onboarding and ChartWarden has approved go-live."
      action={<Link to={ONBOARDING_HOME}>Back to onboarding</Link>}
    />
  );
}
