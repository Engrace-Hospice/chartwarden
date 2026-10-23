import { ApiClientProvider, CorrelationIdProvider, ErrorBoundary } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @chartwarden/portal — the portal SPA shell (M31 §5.1, ADR-0030). Composes the cross-cutting providers around a
// react-router router built from the portal screen registry. Chromeless surfaces (the sign-in flow) are
// top-level routes; every other §5.1 screen renders inside the portal frame (brand bar + reading column).
// The shell reads the registry but imports no screen directly — screens register at composition (main.tsx),
// the same discipline the M1 web shell keeps.
import { createElement, useEffect, useMemo } from "react";
import type { JSX } from "react";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { PORTAL_BASE_PATH } from "./base-path";
import { PortalNotFound, PortalRouteError } from "./not-found";
import { PortalAppShell } from "./portal-shell";
import { createPortalRegistry, portalScreens } from "./screens/registry";
import type { SessionGuard } from "./session-guard";

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-portal";
}

export interface PortalAppProps {
  client: ApiClient;
  correlationId?: string;
  /** The guard whose `onResponseStatus` the client was built with; bound to the router here (#593). */
  sessionGuard?: SessionGuard;
}

export function PortalApp({
  client,
  correlationId = newCorrelationId(),
  sessionGuard,
}: PortalAppProps): JSX.Element {
  const router = useMemo(() => {
    const registry = createPortalRegistry();
    registry.register(portalScreens);
    const screens = registry.screens();
    const chromeless = screens.filter((s) => s.chrome === false);
    const chromed = screens.filter((s) => s.chrome !== false);
    const routes: RouteObject[] = [
      {
        // Pathless root: its errorElement catches every route error beneath it (a screen that throws, a loader
        // failure) and the `*` route catches unknown URLs, so React Router's developer-facing default page
        // never reaches a family member (#594). Both are chromeless: no patient lookup, no API call.
        errorElement: <PortalRouteError />,
        children: [
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
          { path: "*", element: <PortalNotFound /> },
        ],
      },
    ];
    return createBrowserRouter(routes, { basename: PORTAL_BASE_PATH || "/" });
  }, []);

  useEffect(() => sessionGuard?.attach(router), [router, sessionGuard]);

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
