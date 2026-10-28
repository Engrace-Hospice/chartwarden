import type { ScreenRegistry } from "@chartwarden/types";
import {
  ApiClientProvider,
  CorrelationIdProvider,
  ErrorBoundary,
  Glyph,
  LoadingSpinner,
  ToastProvider,
} from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// apps/admin — the Platform-Ops console SPA shell (M34 §5.1, ADR-0030). The ChartWarden-staff control-plane
// analogue of apps/web/src/shell + apps/portal's shell: it composes the cross-cutting providers around a
// react-router router built from the admin screen registry, framed by the console layout (shell/layout.tsx —
// the clinical app's sidebar + top bar). The shell reads the registry but imports NO module slice
// directly — slices register at composition (main.tsx), the same discipline the M1 web shell keeps.
import { Suspense, createElement, useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { Link, RouterProvider, createBrowserRouter } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { type AdminNavSection, buildAdminNav } from "./shell/admin-nav";
import { AdminLayout } from "./shell/layout";
import type { AdminScreen } from "./shell/registry";
import { RequireChrome } from "./shell/require-chrome";
import { ActorSessionProvider } from "./shell/session";
import type { Session } from "./shell/session";

function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return "cid-admin";
}

/** The console landing at "/": every surface, grouped as in the sidebar. */
function AdminHome({ sections }: { sections: readonly AdminNavSection[] }): JSX.Element {
  const groups = sections.filter((s) => s.label !== null);
  return (
    <div className="wx-admin-home">
      <div className="wx-page-head">
        <div>
          <h1>Platform operations</h1>
          <p>Tenants, compliance, subscription billing, AI safety and platform health.</p>
        </div>
      </div>
      <div className="wx-admin-home-grid">
        {groups.map((section) => (
          <section
            key={section.label}
            className="wx-admin-home-group"
            aria-label={section.label ?? ""}
          >
            <h2>{section.label}</h2>
            <ul>
              {section.entries.map((entry) => (
                <li key={entry.key}>
                  <Link to={entry.to}>
                    <Glyph name={entry.icon} size={18} strokeWidth={1.75} />
                    <span>{entry.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export interface AdminAppProps {
  /** The screen registry the composition root has registered platform-module slices into. */
  registry: ScreenRegistry<AdminScreen>;
  client: ApiClient;
  /** Pre-resolved session (tests) — skips ActorSessionProvider's self-load when given. */
  session?: Session | null;
  correlationId?: string;
}

/**
 * Suspense boundary for a lazily-loaded route screen — the apps/web shell's `withSuspense` (TASK-033
 * route-level code-splitting), which this console lacked.
 *
 * Without it a slice registering `lazy()` screens renders BLANK rather than erroring: React suspends,
 * finds no boundary, and the route contributes nothing. That is why every admin slice so far imports its
 * screens eagerly — and why the console's initial bundle is 412 kB against a 350 kB budget with no way
 * for a slice to opt out. One boundary makes per-slice code-splitting possible for all of them.
 */
function withSuspense(element: ReactNode): JSX.Element {
  return <Suspense fallback={<LoadingSpinner label="Loading…" />}>{element}</Suspense>;
}

export function AdminApp({
  registry,
  client,
  session = null,
  correlationId = newCorrelationId(),
}: AdminAppProps): JSX.Element {
  const router = useMemo(() => {
    const screens = registry.screens();
    const chromeless = screens.filter((s) => s.chrome === false);
    const chromed = screens.filter((s) => s.chrome !== false);
    const nav = buildAdminNav(chromed);
    const routes: RouteObject[] = [
      ...chromeless.map((s) => ({ path: s.path, element: withSuspense(createElement(s.screen)) })),
      {
        // Pathless layout route: wraps the landing + every chromed screen in the console frame,
        // gated on an authenticated, platform_ops-holding session (RequireChrome).
        element: (
          <RequireChrome>
            <AdminLayout sections={nav} screens={chromed} />
          </RequireChrome>
        ),
        children: [
          { index: true, element: <AdminHome sections={nav} /> },
          ...chromed.map((s) => ({
            path: s.path.replace(/^\//, ""),
            element: withSuspense(createElement(s.screen)),
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
          <ActorSessionProvider initial={session}>
            {/* The admin console had no ToastProvider, so `useToast()` — the house pattern for
                transient feedback, and the only one apps/web screens use — THREW and took the whole
                screen down with it (caught by the admin screen-smoke test, #29). Mounted here at the
                composition root, exactly as apps/web/src/shell/app.tsx does. */}
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ActorSessionProvider>
        </ApiClientProvider>
      </CorrelationIdProvider>
    </ErrorBoundary>
  );
}
