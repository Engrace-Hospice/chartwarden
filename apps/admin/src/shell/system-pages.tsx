import type { ScreenRegistryModule } from "@wardenx/types";
import { CenteredStatusLayout, Glyph, useCorrelationId } from "@wardenx/ui";
// apps/admin/src/shell — System / Utility Pages (M1 cross-cutting, ADR-0030). Ported from
// apps/web/src/shell/system-pages.tsx, trimmed to the three states this app's guard actually
// produces (RequireChrome → /login, /403, /error — no idle-lock/maintenance-banner machinery here).
// PHI-free, always a forward action. Registered chromeless — `*` is the global not-found catch-all,
// so a bad URL never falls through to React Router's raw default error UI.
import type { JSX } from "react";
import type { ComponentType } from "react";
import { Link } from "react-router-dom";

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
      explanation="This console is limited to platform-ops staff. Contact your administrator if you believe this is a mistake."
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

/** Routable utility pages (chromeless). `*` is the global not-found catch-all. */
export const adminSystemScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 1,
  slug: "system",
  screens: [
    { id: "system.not-found", path: "*", title: "Not found", chrome: false, screen: NotFound },
    { id: "system.forbidden", path: "/403", title: "Forbidden", chrome: false, screen: Forbidden },
    { id: "system.error", path: "/error", title: "Error", chrome: false, screen: ServerError },
  ],
};
