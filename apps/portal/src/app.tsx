import { ApiClientProvider, CorrelationIdProvider, ErrorBoundary } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @chartwarden/portal — the portal SPA shell (M31 §5.1, ADR-0030). Composes the cross-cutting providers around a
// react-router router built from the portal screen registry. Chromeless surfaces (the sign-in flow) are
// top-level routes; every other §5.1 screen renders inside the portal frame (brand bar + reading column).
// The shell reads the registry but imports no screen directly — screens register at composition (main.tsx),
// the same discipline the M1 web shell keeps.
import { createElement, useMemo } from "react";
import type { JSX } from "react";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { PORTAL_BASE_PATH } from "./base-path";
import { PortalAppShell } from "./portal-shell";
import { createPortalRegistry, portalScreens } from "./screens/registry";

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-portal";
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
        element: <PortalAppShell />,
        children: chromed.map((s) => ({
          path: s.path.replace(/^\//, ""),
          element: createElement(s.screen),
        })),
      },
    ];
    return createBrowserRouter(routes, { basename: PORTAL_BASE_PATH });
  }, []);

  return (
    <ErrorBoundary correlationId={correlationId}>
      <CorrelationIdProvider value={correlationId}>
        <ApiClientProvider client={client}>
          <div className="wx-portal">
            <RouterProvider router={router} />
          </div>
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
