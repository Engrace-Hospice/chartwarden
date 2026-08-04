import { PlatformOpsShell } from "@wardenx/admin-ui-shell";
import type { PlatformNavItem } from "@wardenx/admin-ui-shell";
import type { ScreenRegistry } from "@wardenx/types";
import { ApiClientProvider, CorrelationIdProvider, ErrorBoundary, t } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
// apps/admin — the Platform-Ops console SPA shell (M34 §5.1, ADR-0030). The WardenX-staff control-plane
// analogue of apps/web/src/shell + apps/portal's shell: it composes the cross-cutting providers around a
// react-router router built from the admin screen registry, framed by the @wardenx/admin-ui-shell
// PlatformOpsShell chrome (top bar + nav rail). The shell reads the registry but imports NO module slice
// directly — slices register at composition (main.tsx), the same discipline the M1 web shell keeps.
import { createElement, useMemo } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter, useLocation } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import type { AdminScreen, AdminScreenDescriptor } from "./shell/registry";

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-admin";
}

/** SPA nav-link styling — primary-tint selected row, No-Line — mirroring the shell's default anchors. */
function navLinkStyle(active: boolean): CSSProperties {
  return {
    display: "block",
    padding: "0.5rem 0.625rem",
    borderRadius: t.radiusMd,
    textDecoration: "none",
    fontFamily: t.fontSans,
    fontSize: "0.9rem",
    fontWeight: active ? 600 : 500,
    background: active ? t.primaryTint : "transparent",
    color: active ? t.primary : t.onSurface,
  };
}

/** Derive the nav rail from the registered chromed, non-parameterised screens (one row per surface). */
function buildNav(screens: AdminScreenDescriptor[]): PlatformNavItem[] {
  return screens
    .filter((s) => s.chrome !== false && !s.path.includes(":"))
    .map((s) => ({ key: s.id, label: s.title, to: s.path }));
}

/** The pre-slice landing shown at "/" before a platform-module surface is selected. */
function AdminHome(): JSX.Element {
  return (
    <div style={{ padding: "1.5rem 1.75rem", color: t.onSurface }}>
      <h1 style={{ fontFamily: t.fontDisplay, fontSize: "1.4rem", fontWeight: 600, margin: 0 }}>
        Platform Operations
      </h1>
      <p style={{ color: t.onSurfaceVariant, marginTop: "0.5rem", maxWidth: "40rem" }}>
        Select a surface from the nav rail. Platform modules contribute their screens into this
        shell.
      </p>
    </div>
  );
}

/** The authenticated console frame: PlatformOpsShell chrome (top bar + rail) around the active screen. */
function AdminFrame({ nav }: { nav: readonly PlatformNavItem[] }): JSX.Element {
  const location = useLocation();
  const activeKey = nav.find(
    (n) => n.to === location.pathname || location.pathname.startsWith(`${n.to}/`),
  )?.key;
  return (
    <PlatformOpsShell
      nav={nav}
      activeKey={activeKey}
      renderNavLink={(item, active) => (
        <Link to={item.to} style={navLinkStyle(active)} aria-current={active ? "page" : undefined}>
          {item.label}
        </Link>
      )}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <Outlet />
      </div>
    </PlatformOpsShell>
  );
}

export interface AdminAppProps {
  /** The screen registry the composition root has registered platform-module slices into. */
  registry: ScreenRegistry<AdminScreen>;
  client: ApiClient;
  correlationId?: string;
}

export function AdminApp({
  registry,
  client,
  correlationId = newCorrelationId(),
}: AdminAppProps): JSX.Element {
  const router = useMemo(() => {
    const screens = registry.screens();
    const chromeless = screens.filter((s) => s.chrome === false);
    const chromed = screens.filter((s) => s.chrome !== false);
    const nav = buildNav(chromed);
    const routes: RouteObject[] = [
      ...chromeless.map((s) => ({ path: s.path, element: createElement(s.screen) })),
      {
        // Pathless layout route: wraps the landing + every chromed screen in the console frame.
        element: <AdminFrame nav={nav} />,
        children: [
          { index: true, element: <AdminHome /> },
          ...chromed.map((s) => ({
            path: s.path.replace(/^\//, ""),
            element: createElement(s.screen),
          })),
        ],
      },
    ];
    return createBrowserRouter(routes);
  }, [registry]);

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
