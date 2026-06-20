// apps/web/src/shell — app-shell chrome (M1, ADR-0030). Renders the primary nav (built from the
// registered screens), the degraded-mode banner, a header with the session identity, and the routed
// <Outlet/>. Imports only @wardenx/ui (leaf) + react-router — never a feature module.
import type { JSX } from "react";
import { Link, Outlet } from "react-router-dom";
import { DegradedBanner, EmptyState } from "@wardenx/ui";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";

export interface AppLayoutProps {
  screens: WebScreenDescriptor[];
}

export function AppLayout({ screens }: AppLayoutProps): JSX.Element {
  const session = useSession();
  return (
    <div className="wx-shell">
      <DegradedBanner />
      <header className="wx-header">
        <span className="wx-brand">WardenX</span>
        <span className="wx-actor">{session ? (session.displayName ?? session.userId) : "Not signed in"}</span>
      </header>
      <div className="wx-body">
        <nav className="wx-nav" aria-label="Primary">
          <Link to="/">Home</Link>
          {screens.map((s) => (
            <Link key={s.id} to={s.path}>
              {s.title}
            </Link>
          ))}
        </nav>
        <main className="wx-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Default landing screen until module screens are registered. */
export function HomeScreen(): JSX.Element {
  return (
    <EmptyState
      title="WardenX"
      description="The app shell is running. Module screens appear here as they are registered."
    />
  );
}
