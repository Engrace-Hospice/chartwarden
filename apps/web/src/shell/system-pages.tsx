import type { ScreenRegistryModule } from "@wardenx/types";
import { CenteredStatusLayout, useCorrelationId } from "@wardenx/ui";
// apps/web/src/shell — System / Utility Pages (M1 cross-cutting, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md — "Use System Page."
// One pattern (CenteredStatusLayout), several states: 403/404/500/offline/maintenance/expired/
// suspended. PHI-free, always a forward action. These are M1 (the app shell owns them), registered
// chromeless (standalone, outside the app chrome — they must work pre-auth too).
import type { JSX } from "react";
import type { ComponentType } from "react";
import { Link } from "react-router-dom";

const GoHome = (): JSX.Element => <Link to="/">Go home</Link>;

export function NotFound(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon="🔍"
      headline="We couldn’t find that"
      explanation="The page you’re looking for doesn’t exist."
      actions={<GoHome />}
    />
  );
}

export function Forbidden(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon="🔒"
      headline="You don’t have access to this"
      explanation="Your account doesn’t have permission to view this page."
      actions={<GoHome />}
    />
  );
}

export function ServerError(): JSX.Element {
  const correlationId = useCorrelationId();
  return (
    <CenteredStatusLayout
      icon="⚠️"
      headline="Something went wrong"
      explanation="An unexpected error occurred. Please try again."
      actions={<GoHome />}
      correlationId={correlationId ?? undefined}
    />
  );
}

export function Offline(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon="📡"
      headline="You’re offline"
      explanation="Check your connection and try again."
      actions={
        <button type="button" onClick={() => window.location.reload()}>
          Retry
        </button>
      }
    />
  );
}

export function Maintenance(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon="🛠️"
      headline="WardenX is undergoing maintenance"
      explanation="We’ll be back shortly. Thank you for your patience."
    />
  );
}

export function SessionExpired(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon="⏳"
      headline="Your session ended"
      explanation="For your security, you were signed out."
      actions={<Link to="/login/organization">Sign in</Link>}
    />
  );
}

export function Suspended(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon="🚫"
      headline="Organization access unavailable"
      explanation="This organization’s access is currently unavailable. Please contact your administrator."
    />
  );
}

/** Routable utility pages (chromeless). `*` is the global not-found catch-all. */
export const systemScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 1,
  slug: "system",
  screens: [
    { id: "system.not-found", path: "*", title: "Not found", chrome: false, screen: NotFound },
    { id: "system.forbidden", path: "/403", title: "Forbidden", chrome: false, screen: Forbidden },
    { id: "system.error", path: "/error", title: "Error", chrome: false, screen: ServerError },
    { id: "system.offline", path: "/offline", title: "Offline", chrome: false, screen: Offline },
    {
      id: "system.maintenance",
      path: "/maintenance",
      title: "Maintenance",
      chrome: false,
      screen: Maintenance,
    },
    {
      id: "system.session-expired",
      path: "/expired",
      title: "Session expired",
      chrome: false,
      screen: SessionExpired,
    },
    {
      id: "system.suspended",
      path: "/suspended",
      title: "Suspended",
      chrome: false,
      screen: Suspended,
    },
  ],
};
