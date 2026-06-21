// apps/web/src/shell — the app shell (M1, ADR-0030). Composes the cross-cutting providers
// (error boundary, correlation id, API client, session, feature flags, system status) around a
// react-router router built from the screen registry. The shell reads the registry but never
// imports a feature module — modules register their screens at composition (apps/web/src/main.tsx).
import { createElement, useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import {
  ApiClientProvider,
  CorrelationIdProvider,
  ErrorBoundary,
  FeatureFlagProvider,
  SystemStatusProvider,
} from "@wardenx/ui";
import type { ApiClient, FeatureFlags, SystemStatusComponent } from "@wardenx/ui";
import type { ScreenRegistry } from "@wardenx/types";
import { AppLayout } from "./layout";
import { RoleHome } from "./role-home";
import type { WebScreen } from "./screen-registry";
import { SessionProvider } from "./session";
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
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "cid-shell";
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
        element: <AppLayout screens={chromed} overlay={chromeOverlay} />,
        children: [
          { index: true, element: <RoleHome screens={chromed} /> },
          ...chromed.map((s) => ({ path: s.path.replace(/^\//, ""), element: createElement(s.screen) })),
        ],
      },
    ];
    return createBrowserRouter(routes);
  }, [registry, chromeOverlay]);

  return (
    <ErrorBoundary correlationId={correlationId}>
      <CorrelationIdProvider value={correlationId}>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <FeatureFlagProvider flags={flags}>
              <SystemStatusProvider components={systemStatus}>
                <RouterProvider router={router} />
              </SystemStatusProvider>
            </FeatureFlagProvider>
          </SessionProvider>
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
