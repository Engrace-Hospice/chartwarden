import type { ScreenRegistryModule } from "@chartwarden/types";
import { CenteredStatusLayout, Glyph, useCorrelationId } from "@chartwarden/ui";
// apps/web/src/shell — System / Utility Pages (M1 cross-cutting, Track A).
// Spec: docs/design/screens/core/CHARTWARDEN_UI_SYSTEM_UTILITY_PAGES.md — "Use System Page."
// Matched to the P0 Pencil frame (chartwarden-P0-foundation.pen `dT1Bt`): each state is a System Page —
// a circular tonal icon badge (Lantern inline-SVG Glyph, NOT emoji — §10.10) + Fraunces headline +
// muted explanation + a forward action. One pattern (CenteredStatusLayout), several states:
// 403/404/500/offline/maintenance/expired/suspended. PHI-free, always a forward action. These are
// M1 (the app shell owns them), registered chromeless (standalone — they must work pre-auth too).
import type { JSX } from "react";
import type { ComponentType } from "react";
import { Link, useSearchParams } from "react-router-dom";

const GoHome = (): JSX.Element => <Link to="/">Go home</Link>;

export function NotFound(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon={<Glyph name="info" size={24} />}
      headline="We couldn’t find that"
      explanation="The page you’re looking for doesn’t exist."
      actions={<GoHome />}
    />
  );
}

export function Forbidden(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon={<Glyph name="lock" size={24} />}
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
      icon={<Glyph name="alert" size={24} />}
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
      icon={<Glyph name="block" size={24} />}
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
      icon={<Glyph name="clock" size={24} />}
      headline="ChartWarden is undergoing maintenance"
      explanation="We’ll be back shortly. Thank you for your patience."
    />
  );
}

export function SessionExpired(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon={<Glyph name="clock" size={24} />}
      headline="Your session ended"
      explanation="For your security, you were signed out."
      actions={<Link to="/login">Sign in</Link>}
    />
  );
}

export function Suspended(): JSX.Element {
  return (
    <CenteredStatusLayout
      icon={<Glyph name="block" size={24} />}
      headline="Organization access unavailable"
      explanation="This organization’s access is currently unavailable. Please contact your administrator."
    />
  );
}

const TENANT_UNAVAILABLE_COPY = {
  closed: {
    headline: "This organization is no longer on ChartWarden",
    explanation:
      "This address is no longer in use. If you think this is a mistake, contact your administrator.",
  },
  suspended: {
    headline: "This organization is suspended",
    explanation: "Access to this organization is paused. Contact your administrator.",
  },
  unknown: {
    headline: "No organization at this address",
    explanation: "Check the address you were given, or ask your administrator for the right link.",
  },
} as const;

/** ADR-0049: a closed / suspended / unknown tenant host. Static and PHI-free; `?reason=` picks the copy. */
export function TenantUnavailable(): JSX.Element {
  const [params] = useSearchParams();
  const reason = params.get("reason");
  const copy =
    reason === "closed" || reason === "suspended"
      ? TENANT_UNAVAILABLE_COPY[reason]
      : TENANT_UNAVAILABLE_COPY.unknown;
  return (
    <CenteredStatusLayout
      icon={<Glyph name="block" size={24} />}
      headline={copy.headline}
      explanation={copy.explanation}
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
      id: "system.tenant-unavailable",
      path: "/tenant-unavailable",
      title: "Organization unavailable",
      chrome: false,
      screen: TenantUnavailable,
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
