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
import { Suspense, createElement, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { JSX, ReactNode } from "react";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useNavigate,
} from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { guardChromedRoute } from "./actor-session";
import {
  getGlobalResponseSignal,
  setGlobalResponseSignal,
  subscribeGlobalResponseSignal,
} from "./global-response-signal";
import { AppLayout } from "./layout";
import { AlertInboxProvider } from "./alert-inbox";
import { OfflineBanner } from "./offline-banner";
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
 * applies the pre-org `needsOrgSelection` redirect). An `outage` (TASK-033 / FLOW-004) — the initial
 * context load couldn't reach the backend at all, or got back a non-401 error — sends the actor to
 * the offline page instead of force-logging them out. The server still enforces every route.
 */
function RequireChrome({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useSessionState();
  const outcome = guardChromedRoute(status);
  if (outcome === "loading") return <LoadingSpinner label="Loading workspace…" />;
  if (outcome === "redirect") return <Navigate to="/login" replace />;
  if (outcome === "outage") return <Navigate to="/offline" replace />;
  return <>{children}</>;
}

/** Suspense boundary for a lazily-loaded route screen (TASK-033 route-level code-splitting). */
function withSuspense(element: ReactNode): JSX.Element {
  return <Suspense fallback={<LoadingSpinner label="Loading…" />}>{element}</Suspense>;
}

/**
 * Watches the API client's global response-status signal (TASK-033) and navigates the WHOLE app —
 * chromed or chromeless — off a 401 (→ /expired) or a 503 (→ /maintenance) observed on any request,
 * not just the initial session bootstrap. Mounted once at the router root (`RootWatcher` below) so
 * it has `useNavigate` access regardless of which route is currently active.
 *
 * A 401 only means "your session ended" the FIRST time it's observed after being authenticated —
 * gated on `status === "authenticated"` plus a one-shot ref. Without the status gate, an expected
 * pre-auth 401 (e.g. /login/organization probing `/auth/memberships` while genuinely signed out)
 * fires the same signal and bounces straight back to /expired. The ref guard covers the case right
 * after that first bounce: `session.tsx`'s status stays stale at "authenticated" (nothing else
 * re-checks it) until a fresh sign-in, so the very next 401 — e.g. clicking /expired's own "Sign
 * in" link — would otherwise re-pass the status check and loop back to /expired again, turning it
 * into a dead end (both caught live-testing TASK-033). A fresh "authenticated" status (a real
 * sign-in) clears the ref so a later, genuine mid-session expiry still redirects.
 * A 503 has no such caveat — the service is down regardless of who's asking.
 */
function GlobalResponseWatcher(): null {
  const navigate = useNavigate();
  const { status } = useSessionState();
  const signal = useSyncExternalStore(subscribeGlobalResponseSignal, getGlobalResponseSignal);
  const alreadyExpiredRef = useRef(false);
  useEffect(() => {
    if (status === "authenticated") alreadyExpiredRef.current = false;
  }, [status]);
  useEffect(() => {
    if (!signal) return;
    if (signal.kind === "session-expired") {
      if (status === "authenticated" && !alreadyExpiredRef.current) {
        alreadyExpiredRef.current = true;
        navigate("/expired");
      }
    } else {
      navigate("/maintenance");
    }
    setGlobalResponseSignal(null); // consume — don't re-fire the same signal on every re-render
  }, [signal, navigate, status]);
  return null;
}

/** Pathless layout route so `GlobalResponseWatcher` wraps every route, chromed or chromeless. */
function RootWatcher(): JSX.Element {
  return (
    <>
      <GlobalResponseWatcher />
      <Outlet />
    </>
  );
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
      {
        element: <RootWatcher />,
        children: [
          ...chromeless.map((s) => ({
            path: s.path,
            element: withSuspense(createElement(s.screen)),
          })),
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
                element: withSuspense(createElement(s.screen)),
              })),
            ],
          },
        ],
      },
    ];
    return createBrowserRouter(routes);
  }, [registry, chromeOverlay]);

  return (
    <ErrorBoundary correlationId={correlationId}>
      <OfflineBanner />
      <CorrelationIdProvider value={correlationId}>
        <ApiClientProvider client={client}>
          {/* Self-loads the actor's role/membership context (FB-T15) unless one is injected. */}
          <ActorSessionProvider initial={session}>
            <FeatureFlagProvider flags={flags}>
              <SystemStatusProvider components={systemStatus}>
                <ToastProvider>
                  <AlertInboxProvider>
                    <RouterProvider router={router} />
                  </AlertInboxProvider>
                </ToastProvider>
              </SystemStatusProvider>
            </FeatureFlagProvider>
          </ActorSessionProvider>
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
