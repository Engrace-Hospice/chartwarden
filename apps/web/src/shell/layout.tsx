// apps/web/src/shell — app-shell chrome (M1, ADR-0030). Renders the primary nav (built from the
// registered screens), the degraded-mode banner, a header with the session identity, and the routed
// <Outlet/>. Imports only @wardenx/ui (leaf) + react-router — never a feature module.
import { useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { DegradedBanner, EmptyState } from "@wardenx/ui";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";

export interface AppLayoutProps {
  screens: WebScreenDescriptor[];
  /** Optional overlay (e.g. the idle screen-lock) injected by the composition root — see AppShell. */
  overlay?: ReactNode;
}

export function AppLayout({ screens, overlay }: AppLayoutProps): JSX.Element {
  const session = useSession();
  return (
    <div className="wx-shell">
      <DegradedBanner />
      <header className="wx-header">
        <span className="wx-brand">WardenX</span>
        {/* Top-nav global search (FB-T11). Module-free: it only navigates to the registered
            /search route — the Global Search screen (M5) owns the query + facets. */}
        <TopNavSearch />
        <span className="wx-actor">{session ? (session.displayName ?? session.userId) : "Not signed in"}</span>
      </header>
      <div className="wx-body">
        <nav className="wx-nav" aria-label="Primary">
          <Link to="/">Home</Link>
          {/* Detail screens (param paths like /patients/:id) are reached programmatically, not via nav. */}
          {screens
            .filter((s) => !s.path.includes(":"))
            .map((s) => (
              <Link key={s.id} to={s.path}>
                {s.title}
              </Link>
            ))}
        </nav>
        <main className="wx-main">
          <Outlet />
        </main>
      </div>
      {overlay}
    </div>
  );
}

/** Shell top-nav search box. Submits to the registered /search route (Global Search, M5). */
function TopNavSearch(): JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  function submit(e: FormEvent): void {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/search?q=${encodeURIComponent(term)}` : "/search");
  }
  return (
    <form className="wx-topnav-search" onSubmit={submit} role="search">
      <input
        type="search"
        aria-label="Global search"
        placeholder="Search patients, staff…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
    </form>
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
