// apps/web/src/modules/34-saas/wizard — the shell's onboarding gate. While the organization is still being onboarded the server refuses
// every route outside its allowlist (403 ORGANIZATION_ONBOARDING), so a screen that calls anything else could only fail. This guard sends
// the landing page to the wizard and says "Available after go-live" on the other chromed screens instead. Which screens work, and the
// server allowlist they pair with, are declared once in shell/onboarding-stage.ts (the app shell's own watcher reads the same list).
// It acts only when the session says `organizationStage === "onboarding"`; an absent stage is unknown, and the shell stays normal (the
// server is the authority either way). Injected into the shell by main.tsx, so the shell imports no feature module.
import { Button, EmptyState } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ONBOARDING_HOME,
  isOnboardingScreen,
  isOnboardingSession,
} from "../../../shell/onboarding-stage";
import { useSession } from "../../../shell/session";

export function OnboardingScreenGate({
  path,
  children,
}: {
  /** The registered path of the screen being shown ("/" for the landing page). */
  path: string;
  children: ReactNode;
}): JSX.Element {
  const confined = isOnboardingSession(useSession());
  if (!confined) return <>{children}</>;
  if (path === "/") return <Navigate to={ONBOARDING_HOME} replace />;
  if (isOnboardingScreen(path)) return <>{children}</>;
  return (
    <EmptyState
      title="Available after go-live"
      description="This part of ChartWarden opens once your organization has finished onboarding and ChartWarden has approved go-live. If it has just gone live, reload to open it."
      action={
        <>
          <Link to={ONBOARDING_HOME}>Back to onboarding</Link>{" "}
          <Button size="sm" tone="secondary" onClick={() => window.location.assign("/")}>
            Reload
          </Button>
        </>
      }
    />
  );
}
