import type { ScreenRegistry } from "@wardenx/types";
import {
  ApiClientProvider,
  CorrelationIdProvider,
  ErrorBoundary,
  FeatureFlagProvider,
  LoadingSpinner,
  SystemStatusProvider,
  ToastProvider,
} from "@wardenx/ui";
import type { ApiClient, FeatureFlags, SystemStatusComponent } from "@wardenx/ui";
// apps/web/src/shell — the app shell (M1, ADR-0030). Composes the cross-cutting providers
// (error boundary, correlation id, API client, session, feature flags, system status) around a
// react-router router built from the screen registry. The shell reads the registry but never
// imports a feature module — modules register their screens at composition (apps/web/src/main.tsx).
import { createElement, useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { guardChromedRoute } from "./actor-session";
import { AppLayout } from "./layout";
import { RoleHome } from "./role-home";
import type { WebScreen } from "./screen-registry";
import { ActorSessionProvider, useSessionState } from "./session";
import type { Session } from "./session";

export interface AppShellProps {
  registry: ScreenRegistry<WebScreen>;
  client: ApiClient;
  session?: Session | null;
  flags?: FeatureFlags;
  systemStatus?: SystemStatusComponent[];
  correlationId?: string;
  /**
   * An overlay rendered inside the authenticated app frame (the AppLayout) — e.g. M2's idle
   * screen-lock. Injected by the composition root so the shell stays free of feature-module imports
   * (ADR-0030). Only mounts over chromed screens; the chromeless auth flow is never overlaid.
   */
  chromeOverlay?: ReactNode;
}

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-shell";
}

/**
 * Route guard for the chromed app frame (audit #6): no chromed route renders until the session is
 * resolved. While loading we show a spinner (no chrome flash, no premature redirect); an anonymous
 * actor is sent to the chromeless /login flow; an authenticated actor renders the layout (which then
 * applies the pre-org `needsOrgSelection` redirect). The server still enforces every route.
 */
function RequireChrome({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useSessionState();
  const outcome = guardChromedRoute(status);
  if (outcome === "loading") return <LoadingSpinner label="Loading workspace…" />;
  if (outcome === "redirect") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function AppShell({
  registry,
  client,
  session = null,
  flags = {},
  systemStatus = [],
  correlationId = newCorrelationId(),
  chromeOverlay,
}: AppShellProps): JSX.Element {
  const router = useMemo(() => {
    const screens = registry.screens();
    // Chromeless screens (Auth Flow, System Page — ADR-0030) are standalone top-level routes;
    // chromed screens render inside the AppLayout shell and appear in its nav.
    const chromeless = screens.filter((s) => s.chrome === false);
    const chromed = screens.filter((s) => s.chrome !== false);
    const routes: RouteObject[] = [
      ...chromeless.map((s) => ({ path: s.path, element: createElement(s.screen) })),
      {
        path: "/",
        element: (
          <RequireChrome>
            <AppLayout screens={chromed} overlay={chromeOverlay} />
          </RequireChrome>
        ),
        children: [
          { index: true, element: <RoleHome screens={chromed} /> },
          ...chromed.map((s) => ({
            path: s.path.replace(/^\//, ""),
            element: createElement(s.screen),
          })),
        ],
      },
    ];
    return createBrowserRouter(routes);
  }, [registry, chromeOverlay]);

  return (
    <ErrorBoundary correlationId={correlationId}>
      <CorrelationIdProvider value={correlationId}>
        <ApiClientProvider client={client}>
          {/* Self-loads the actor's role/membership context (FB-T15) unless one is injected. */}
          <ActorSessionProvider initial={session}>
            <FeatureFlagProvider flags={flags}>
              <SystemStatusProvider components={systemStatus}>
                <ToastProvider>
                  <RouterProvider router={router} />
                </ToastProvider>
              </SystemStatusProvider>
            </FeatureFlagProvider>
          </ActorSessionProvider>
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
