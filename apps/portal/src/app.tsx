import { ApiClientProvider, CorrelationIdProvider, ErrorBoundary } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
// @wardenx/portal — the portal SPA shell (M31 §5.1, ADR-0030). Composes the cross-cutting providers around a
// react-router router built from the portal screen registry. Chromeless surfaces (the sign-in flow) are
// top-level routes; every other §5.1 screen renders inside the portal frame (brand bar + reading column).
// The shell reads the registry but imports no screen directly — screens register at composition (main.tsx),
// the same discipline the M1 web shell keeps.
import { createElement, useMemo } from "react";
import type { JSX } from "react";
import {
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
} from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { createPortalRegistry, portalScreens } from "./screens/registry";

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-portal";
}

const PATIENT_PATH = /^\/p\/([^/]+)/;

function currentPatientId(pathname: string): string | null {
  const encodedId = PATIENT_PATH.exec(pathname)?.[1];
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

/** The authenticated portal frame: calm navigation, patient context, content, and persistent safety help. */
function PortalFrame(): JSX.Element {
  const { pathname } = useLocation();
  const patientId = currentPatientId(pathname);
  const patientBase = patientId ? `/p/${encodeURIComponent(patientId)}` : null;
  const brandDestination = patientBase ?? "/patient-picker";

  return (
    <div className="wx-portal-shell">
      <a className="wx-portal-skip-link" href="#portal-main">
        Skip to main content
      </a>
      <header className="wx-portal-header">
        <div className="wx-portal-header__bar">
          <Link
            className="wx-portal-brand"
            to={brandDestination}
            aria-label="WardenX Family Portal home"
          >
            <span className="wx-portal-brand__mark" aria-hidden="true">
              W
            </span>
            <span>
              <strong>WardenX</strong>
              <small>Family Portal</small>
            </span>
          </Link>

          <NavLink className="wx-portal-account-link" to="/account">
            Account
          </NavLink>
        </div>

        {patientBase ? (
          <nav className="wx-portal-nav" aria-label="Portal navigation">
            <NavLink end to={patientBase}>
              Home
            </NavLink>
            <NavLink to={`${patientBase}/visits`}>Visits</NavLink>
            <NavLink to={`${patientBase}/messages`}>Messages</NavLink>
            <NavLink to={`${patientBase}/documents`}>Documents</NavLink>
          </nav>
        ) : null}
      </header>

      {patientBase ? (
        <div className="wx-portal-context" aria-label="Patient context">
          <span>Viewing a care record</span>
          <Link to="/patient-picker">Switch person</Link>
        </div>
      ) : null}

      <main className="wx-portal-main" id="portal-main">
        <Outlet />
      </main>

      <aside className="wx-portal-urgent-help" aria-label="Urgent care information">
        <strong>Need urgent help?</strong>
        <span>
          Call your hospice team's 24/7 line. For an emergency, call local emergency services.
          Portal messages are not monitored for emergencies.
        </span>
      </aside>
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
          <div className="wx-portal">
            <RouterProvider router={router} />
          </div>
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
