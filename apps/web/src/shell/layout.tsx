import { DegradedBanner, EmptyState, Glyph, NavGroup, NavLink, groupByNavGroup } from "@wardenx/ui";
// apps/web/src/shell — app-shell chrome (M1, ADR-0030). Renders the primary nav (built from the
// registered screens), the degraded-mode banner, a header with the session identity, and the routed
// <Outlet/>. Imports only @wardenx/ui (leaf) + react-router — never a feature module.
import { type MouseEvent, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Navigate, Outlet, useNavigate } from "react-router-dom";
import { canSeeScreen, needsOrgSelection } from "./actor-session";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";
import { useTheme } from "./theme";

export interface AppLayoutProps {
  screens: WebScreenDescriptor[];
  /** Optional overlay (e.g. the idle screen-lock) injected by the composition root — see AppShell. */
  overlay?: ReactNode;
}

export function AppLayout({ screens, overlay }: AppLayoutProps): JSX.Element {
  const session = useSession();
  // Below the responsive breakpoint (TASK-033 / UI-004) the sidebar becomes an off-canvas drawer —
  // a fixed 14rem sidebar plus content leaves under 170px at 390px wide, so it's hidden by default
  // and toggled by the header's hamburger button instead of always occupying the viewport.
  const [navOpen, setNavOpen] = useState(false);
  // Pre-org guard (ADR-0030): an authenticated session with no bound organization can't use ANY
  // org-scoped screen — the server 401/403s every org route, so the shell would render screens that
  // all read "Unavailable". Send the actor to organization-select instead. `/login/organization` is
  // chromeless (outside this layout), so it is never guarded — no redirect loop.
  if (needsOrgSelection(session)) {
    return <Navigate to="/login/organization" replace />;
  }
  // A click on a nav link closes the drawer; a click on a NavGroup's own expand/collapse toggle
  // (not an <a>) should not, or the group would collapse AND the drawer close in the same tap.
  function closeNavOnLinkClick(e: MouseEvent<HTMLElement>): void {
    if ((e.target as HTMLElement).closest("a")) setNavOpen(false);
  }
  return (
    <div className="wx-shell">
      <DegradedBanner />
      <header className="wx-header">
        <button
          type="button"
          className="wx-icon-btn wx-nav-toggle"
          onClick={() => setNavOpen((open) => !open)}
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          aria-controls="wx-primary-nav"
        >
          <Glyph name={navOpen ? "close" : "menu"} size={18} />
        </button>
        <span className="wx-brand">WardenX</span>
        {/* Top-nav global search (FB-T11). Module-free: it only navigates to the registered
            /search route — the Global Search screen (M5) owns the query + facets. */}
        <TopNavSearch />
        <span className="wx-actor">
          {session ? (session.displayName ?? session.userId) : "Not signed in"}
        </span>
        <ThemeToggle />
      </header>
      <div className="wx-body">
        {navOpen ? (
          // biome-ignore lint/a11y/useKeyWithClickEvents: a dismiss backdrop, not a control.
          <div className="wx-nav-backdrop" onClick={() => setNavOpen(false)} />
        ) : null}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: closes the mobile nav on a bubbled click from
            a NavLink descendant, which is already keyboard-navigable — the nav itself isn't a control. */}
        <nav
          id="wx-primary-nav"
          className={navOpen ? "wx-nav wx-nav-open" : "wx-nav"}
          aria-label="Primary"
          onClick={closeNavOnLinkClick}
        >
          <NavLink to="/" end>
            Home
          </NavLink>
          {/* Detail screens (param paths like /patients/:id) are reached programmatically, not via nav.
              Gated screens show only when the actor holds the key (FB-T15 — server still enforces).
              Grouped by navGroup (UI-001) — 35 module screen-sets already declare one; ungrouped
              screens fall into "General" so nothing silently disappears from the sidebar. */}
          {groupByNavGroup(
            screens.filter((s) => !s.path.includes(":")).filter((s) => canSeeScreen(s, session)),
          ).map(([group, items]) => (
            <NavGroup key={group} label={group}>
              {items.map((s) => (
                <NavLink key={s.id} to={s.path}>
                  {s.title}
                </NavLink>
              ))}
            </NavGroup>
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
    // biome-ignore lint/a11y/useSemanticElements: role="search" on the form is the intended, widely-supported pattern.
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

/** Light ⇄ twilight-dark toggle (DESIGN.md §11). Persists the choice; sun in dark, moon in light. */
function ThemeToggle(): JSX.Element {
  const { mode, toggle } = useTheme();
  const dark = mode === "dark";
  return (
    <button
      type="button"
      className="wx-icon-btn"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      <Glyph name={dark ? "sun" : "moon"} size={18} />
    </button>
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
