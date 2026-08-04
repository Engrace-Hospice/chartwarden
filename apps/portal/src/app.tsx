import { ApiClientProvider, CorrelationIdProvider, ErrorBoundary, t } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
// @wardenx/portal — the portal SPA shell (M31 §5.1, ADR-0030). Composes the cross-cutting providers around a
// react-router router built from the portal screen registry. Chromeless surfaces (the sign-in flow) are
// top-level routes; every other §5.1 screen renders inside the portal frame (brand bar + reading column).
// The shell reads the registry but imports no screen directly — screens register at composition (main.tsx),
// the same discipline the M1 web shell keeps.
import { createElement, useMemo } from "react";
import type { JSX } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { createPortalRegistry, portalScreens } from "./screens/registry";

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-portal";
}

/** The authenticated portal frame: brand bar + the screen's own reading column via <Outlet>. */
function PortalFrame(): JSX.Element {
  return (
    <div style={{ minHeight: "100vh", background: t.background, color: t.onSurface }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.85rem 1.25rem",
          borderBottom: `1px solid ${t.surfaceContainer}`,
          background: t.surfaceLowest,
        }}
      >
        <Link
          to="/patient-picker"
          style={{
            textDecoration: "none",
            color: t.onSurface,
            fontFamily: t.fontDisplay,
            fontWeight: 600,
          }}
        >
          WardenX Family Portal
        </Link>
        <Link
          to="/account"
          style={{ textDecoration: "none", color: t.primary, fontWeight: 600, fontSize: "0.85rem" }}
        >
          Account
        </Link>
      </header>
      <Outlet />
    </div>
  );
}

export interface PortalAppProps {
  client: ApiClient;
  correlationId?: string;
}

export function PortalApp({
  client,
  correlationId = newCorrelationId(),
}: PortalAppProps): JSX.Element {
  const router = useMemo(() => {
    const registry = createPortalRegistry();
    registry.register(portalScreens);
    const screens = registry.screens();
    const chromeless = screens.filter((s) => s.chrome === false);
    const chromed = screens.filter((s) => s.chrome !== false);
    const routes: RouteObject[] = [
      ...chromeless.map((s) => ({ path: s.path, element: createElement(s.screen) })),
      {
        // Pathless layout route: wraps every chromed screen in the portal frame without claiming "/"
        // itself (the sign-in screen owns "/"). Children carry their own root-relative paths.
        element: <PortalFrame />,
        children: chromed.map((s) => ({
          path: s.path.replace(/^\//, ""),
          element: createElement(s.screen),
        })),
      },
    ];
    return createBrowserRouter(routes);
  }, []);

  return (
    <ErrorBoundary correlationId={correlationId}>
      <CorrelationIdProvider value={correlationId}>
        <ApiClientProvider client={client}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
