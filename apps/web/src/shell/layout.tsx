import { createWardenxAuthClient } from "@wardenx/auth/client";
import {
  DegradedBanner,
  EmptyState,
  Glyph,
  type GlyphName,
  NavGroup,
  NavLink,
  groupByNavGroup,
  setSearchTerm,
} from "@wardenx/ui";
// apps/web/src/shell — app-shell chrome (M1, ADR-0030). Renders the primary nav (built from the
// registered screens), the degraded-mode banner, a header with the session identity, and the routed
// <Outlet/>. Imports only @wardenx/ui + @wardenx/auth/client (leaves) + react-router — never a
// feature module. `@wardenx/auth/client` is the same Better Auth client factory M2's own
// `auth-client.ts` wraps (a leaf, not a feature-module import) — the shell needs its own instance to
// offer sign-out from the header (live-browser audit #6), the same mechanism the idle screen-lock's
// "Sign out instead" escape hatch already uses.
import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { canSeeScreen, needsOrgSelection } from "./actor-session";
import type { WebScreenDescriptor } from "./screen-registry";
import type { Session } from "./session";
import { useSession } from "./session";
import { useTheme } from "./theme";

const authClient = createWardenxAuthClient();

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s,._@-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

function getScreenIcon(title: string, group?: string): GlyphName {
  const t = title.toLowerCase();
  const g = group?.toLowerCase() ?? "";

  if (g.includes("clinical")) return "heart";
  if (g.includes("billing")) return "dollar";
  if (g.includes("compliance")) return "clipboard-check";
  if (g.includes("supplies")) return "truck";
  if (g.includes("scheduling")) return "calendar";
  if (g.includes("admin")) return "settings";

  if (t.includes("patient")) return "heart";
  if (t.includes("member") || t.includes("staff") || t.includes("user")) return "users";
  if (t.includes("billing") || t.includes("invoice") || t.includes("payment")) return "dollar";
  if (t.includes("schedule") || t.includes("calendar")) return "calendar";
  if (t.includes("supply") || t.includes("inventory")) return "truck";
  if (t.includes("document") || t.includes("file") || t.includes("record")) return "file-text";
  if (
    t.includes("chat") ||
    t.includes("message") ||
    t.includes("portal") ||
    t.includes("communication")
  )
    return "message-square";
  if (t.includes("ai") || t.includes("copilot") || t.includes("intelligence")) return "cpu";
  if (t.includes("security") || t.includes("credential") || t.includes("auth")) return "shield";
  if (t.includes("activity") || t.includes("log") || t.includes("audit")) return "activity";

  return "dot";
}

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
  // `.wx-main` (not the window) is the scroll container (`overflow: auto` — see index.css), so
  // react-router doesn't reset it on navigation. Without this, a deep scroll into a long page
  // (e.g. the Home dashboard tile grid) carries over to the next route and can leave a short
  // destination page rendered off-screen above the viewport (live-browser audit #3).
  const mainRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intentional trigger, not read in the body.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);
  // Sticky workspaces live inside `.wx-main`, below this header. Keep their available-height
  // calculation exact across responsive header wraps and user font scaling rather than duplicating
  // a fragile pixel height in feature CSS.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--wx-app-header-height");
    const update = (): void =>
      root.style.setProperty("--wx-app-header-height", `${header.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      if (previous) root.style.setProperty("--wx-app-header-height", previous);
      else root.style.removeProperty("--wx-app-header-height");
    };
  }, []);
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
      <header ref={headerRef} className="wx-header">
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
        <div
          className="wx-brand-container"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          <div
            className="wx-brand-logo"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "1.75rem",
              height: "1.75rem",
              borderRadius: "var(--radius-md)",
              background:
                "linear-gradient(135deg, var(--color-primary), var(--color-primary-strong))",
              color: "white",
              boxShadow: "var(--shadow-soft)",
            }}
          >
            <Glyph name="shield" size={14} />
          </div>
          <span
            className="wx-brand"
            style={{ fontWeight: 700, fontSize: "1.15rem", letterSpacing: "-0.02em" }}
          >
            WardenX
          </span>
        </div>
        {/* Top-nav global search (FB-T11). Module-free: it only navigates to the registered
            /search route — the Global Search screen (M5) owns the query + facets. */}
        <TopNavSearch />

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginLeft: "auto" }}>
          <ThemeToggle />
          <div
            style={{
              width: "1px",
              height: "1.25rem",
              background: "color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
            }}
          />
          <ActorMenu session={session} />
        </div>
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
          className={navOpen ? "wx-nav wx-nav-open wx-no-scrollbar" : "wx-nav wx-no-scrollbar"}
          aria-label="Primary"
          onClick={closeNavOnLinkClick}
        >
          <NavLink to="/" end>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Glyph name="home" size={16} style={{ opacity: 0.8 }} />
              <span>Home</span>
            </div>
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
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Glyph
                      name={getScreenIcon(s.title, s.navGroup)}
                      size={14}
                      style={{ opacity: 0.8 }}
                    />
                    <span>{s.title}</span>
                  </div>
                </NavLink>
              ))}
            </NavGroup>
          ))}
        </nav>
        <main className="wx-main wx-no-scrollbar" ref={mainRef}>
          <Outlet />
        </main>
      </div>
      {overlay}
    </div>
  );
}

/**
 * Shell top-nav search box. Submits to the registered /search route (Global Search, M5).
 *
 * The needle is handed over IN MEMORY (`setSearchTerm`) and the navigation carries no query string
 * (GAP-080). It used to go as `/search?q=<name|MRN>`, which put a patient name or MRN into the
 * address bar, the history entry, the omnibox autocomplete corpus, and the profile's on-disk
 * session-restore state — PHI outliving the session on a shared device. See
 * packages/ui/src/core/hooks/use-search-term.ts.
 */
function TopNavSearch(): JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  function submit(e: FormEvent): void {
    e.preventDefault();
    setSearchTerm(q);
    navigate("/search");
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on the form is the intended, widely-supported pattern.
    <form
      className="wx-topnav-search"
      onSubmit={submit}
      role="search"
      style={{ position: "relative" }}
    >
      <div
        style={{
          position: "absolute",
          left: "0.75rem",
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--color-on-surface-variant)",
          opacity: 0.6,
          pointerEvents: "none",
        }}
      >
        <Glyph name="search" size={16} />
      </div>
      <input
        type="search"
        aria-label="Global search"
        placeholder="Search patients, staff…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{
          width: "100%",
          paddingLeft: "2.25rem",
          background: "var(--color-surface-low)",
          border: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
          borderRadius: "var(--radius-md)",
          transition: "all 0.15s ease",
        }}
      />
    </form>
  );
}

/**
 * The signed-in actor's name — a discoverable sign-out control, not inert text (live-browser
 * audit #6: before this, the only `signOut()` call in the app was buried in the idle screen-lock's
 * "Sign out instead" escape hatch, so a user finishing a shift on a shared clinical workstation had
 * no direct in-app way to end their session).
 */
function ActorMenu({ session }: { session: Session | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: PointerEvent): void {
      if (!ref.current?.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function signOut(): Promise<void> {
    setOpen(false);
    await authClient.signOut();
    window.location.href = "/login";
  }

  if (!session) {
    return <span className="wx-actor">Not signed in</span>;
  }

  const displayName = session.displayName ?? session.userId;

  return (
    <div className="wx-actor" ref={ref}>
      <button
        type="button"
        className="wx-actor-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
      >
        <div
          style={{
            width: "1.75rem",
            height: "1.75rem",
            borderRadius: "9999px",
            background: "var(--color-primary-tint)",
            color: "var(--color-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: "0.75rem",
          }}
        >
          {getInitials(displayName)}
        </div>
        <span className="wx-actor-name">{displayName}</span>
        <span aria-hidden style={{ fontSize: "0.65rem", opacity: 0.7 }}>
          ▾
        </span>
      </button>
      {open ? (
        <div className="wx-actor-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="wx-actor-menu-item"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
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
