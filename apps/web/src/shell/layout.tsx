import {
  Breadcrumbs,
  DegradedBanner,
  EmptyState,
  Glyph,
  InlineAlert,
  SkipLink,
  setSearchTerm,
  useDisclosureDismiss,
  useOffCanvasNav,
  useTheme,
} from "@chartwarden/ui";
// apps/web/src/shell — app-shell chrome (M1, ADR-0030). Renders the primary nav (built from the
// registered screens), the degraded-mode banner, a header with the session identity, and the routed
// <Outlet/>. Imports only @chartwarden/ui + @chartwarden/auth/client (leaves) + react-router — never a
// feature module. `@chartwarden/auth/client` is the same Better Auth client factory M2's own
// `auth-client.ts` wraps (a leaf, not a feature-module import) — the shell needs its own instance to
// offer sign-out from the header (live-browser audit #6), the same mechanism the idle screen-lock's
// "Sign out instead" escape hatch already uses.
//
// 2026-09-25 redesign: a full-height sidebar (brand + curated nav, primary-nav.ts) beside a column
// holding the top bar and the routed workspace — the mockups' shell.
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { canSeeScreen, needsOrgSelection } from "./actor-session";
import { resolveBreadcrumbs } from "./breadcrumb-navigation";
import { clearAllDrafts } from "./ceremony-drafts";
import { filterIpuNavigation, useIpuNavigationAvailability } from "./ipu-navigation";
import { ModuleNavigationTabs } from "./module-navigation-tabs";
import { NotificationBell } from "./notification-bell";
import { clearPendingNotificationLink } from "./pending-deep-link";
import { type NavEntry, type NavScreen, activeEntryKey, buildPrimaryNav } from "./primary-nav";
import { RedirectRememberingLink } from "./redirect-remembering-link";
import type { WebScreenDescriptor } from "./screen-registry";
import type { Session } from "./session";
import { useSession } from "./session";

// better-auth + WebAuthn are ~45 kB the first paint never needs (#849): load the client only when signing out.
async function signOutOfAuth(): Promise<void> {
  const { createChartWardenAuthClient } = await import("@chartwarden/auth/client");
  await createChartWardenAuthClient().signOut();
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s,._@-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

/** A human role line under the actor's name ("Administrator", "Registered Nurse", …). */
function roleLine(session: Session): string | null {
  if (session.isAdmin) return "Administrator";
  const role = session.roles?.[0];
  if (!role) return null;
  return role
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : `${w[0]!.toUpperCase()}${w.slice(1)}`))
    .join(" ");
}

export interface AppLayoutProps {
  screens: WebScreenDescriptor[];
  /** Optional overlay (e.g. the idle screen-lock) injected by the composition root — see AppShell. */
  overlay?: ReactNode;
}

export function AppLayout({ screens, overlay }: AppLayoutProps): JSX.Element {
  const session = useSession();
  const ipu = useIpuNavigationAvailability();
  // Below the responsive breakpoint (TASK-033 / UI-004) the sidebar becomes an off-canvas drawer —
  // a fixed-width sidebar plus content leaves too little room at 390px wide, so it's hidden by
  // default and toggled by the header's hamburger button instead of always occupying the viewport.
  const { navOpen, setNavOpen, closeForNavigation, sidebarRef, toggleRef } = useOffCanvasNav(
    () => mainRef.current,
  );
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
  // Detail screens (param paths like /patients/:id) are reached programmatically, not via nav.
  // Gated screens show only when the actor holds the key (FB-T15 — server still enforces).
  const visibleScreens = useMemo(
    () =>
      filterIpuNavigation(
        screens.filter((s) => canSeeScreen(s, session)),
        ipu.enabled,
        ipu.hasActiveUnit,
        ipu.isAdmin,
      ),
    [screens, session, ipu.enabled, ipu.hasActiveUnit, ipu.isAdmin],
  );
  const sections = useMemo(() => buildPrimaryNav(visibleScreens), [visibleScreens]);
  const breadcrumbs = useMemo(
    () => resolveBreadcrumbs(pathname, screens, sections, visibleScreens),
    [pathname, screens, sections, visibleScreens],
  );
  const activeKey = activeEntryKey(sections, pathname);
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(activeKey);
  useEffect(() => {
    if (activeKey) setOpenEntryKey(activeKey);
  }, [activeKey]);
  // Pre-org guard (ADR-0030): an authenticated session with no bound organization can't use ANY
  // org-scoped screen — the server 401/403s every org route, so the shell would render screens that
  // all read "Unavailable". Send the actor to organization-select instead. `/login/organization` is
  // chromeless (outside this layout), so it is never guarded — no redirect loop.
  if (needsOrgSelection(session)) {
    // WP 4.8: a notification link finishes after the organisation is chosen
    return <RedirectRememberingLink to="/login/organization" pathname={pathname} />;
  }
  // A click on a nav link closes the drawer; a click on an entry's own disclosure toggle (not an
  // <a>) should not, or the entry would expand AND the drawer close in the same tap.
  function closeNavOnLinkClick(e: MouseEvent<HTMLElement>): void {
    if ((e.target as HTMLElement).closest("a")) closeForNavigation();
  }
  return (
    <div className="wx-shell">
      <SkipLink targetId="wx-main" />
      {navOpen ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: a dismiss backdrop, not a control.
        <div className="wx-nav-backdrop" onClick={() => setNavOpen(false)} />
      ) : null}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: closes the mobile nav on a bubbled click from
          a nav link descendant, which is already keyboard-navigable — the aside itself isn't a control. */}
      <aside
        id="wx-sidebar"
        ref={sidebarRef}
        className={navOpen ? "wx-sidebar wx-nav-open" : "wx-sidebar"}
        onClick={closeNavOnLinkClick}
      >
        <Link to="/" className="wx-brand-block" aria-label="ChartWarden home">
          <span className="wx-brand-logo" aria-hidden>
            <img src="/chartwarden-mark.svg" width="28" height="28" alt="" />
          </span>
          <span className="wx-brand-text">
            <span className="wx-brand">ChartWarden</span>
            <span className="wx-brand-sub">Hospice EHR</span>
          </span>
        </Link>
        <nav id="wx-primary-nav" className="wx-nav wx-no-scrollbar" aria-label="Primary">
          {sections.map((section) => (
            <div key={section.label ?? "main"} className="wx-nav-section">
              {section.label ? <div className="wx-nav-section-label">{section.label}</div> : null}
              {section.entries.map((entry) => (
                <PrimaryNavEntry
                  key={entry.key}
                  entry={entry}
                  active={entry.key === activeKey}
                  pathname={pathname}
                  expanded={entry.key === openEntryKey}
                  onToggle={() =>
                    setOpenEntryKey((current) => (current === entry.key ? null : entry.key))
                  }
                />
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="wx-shell-column">
        <DegradedBanner />
        <header ref={headerRef} className="wx-header">
          <button
            ref={toggleRef}
            type="button"
            className="wx-icon-btn wx-nav-toggle"
            onClick={() => setNavOpen((open) => !open)}
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            aria-controls="wx-sidebar"
          >
            <Glyph name={navOpen ? "close" : "menu"} size={18} />
          </button>
          {/* Top-nav global search (FB-T11). Module-free: it only navigates to the registered
              /search route — the Global Search screen (M5) owns the query + facets. */}
          <TopNavSearch />
          <div className="wx-header-actions">
            <NotificationBell />

            <ThemeToggle />

            <ActorMenu session={session} />
          </div>
        </header>
        <main id="wx-main" className="wx-main wx-no-scrollbar" ref={mainRef} tabIndex={-1}>
          <ModuleNavigationTabs sections={sections} pathname={pathname} />
          <Breadcrumbs items={breadcrumbs} />
          <Outlet />
        </main>
      </div>
      {overlay}
    </div>
  );
}

/**
 * One primary-nav row. An entry with several screens gets a disclosure chevron that reveals them;
 * it opens by itself while one of its screens is current.
 */
export function PrimaryNavEntry({
  entry,
  active,
  pathname,
  expanded,
  onToggle,
}: {
  entry: NavEntry;
  active: boolean;
  pathname: string;
  /** The shell controls this to keep only one top-level group expanded. */
  expanded?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const [localOpen, setLocalOpen] = useState(active);
  useEffect(() => {
    if (active && expanded === undefined) setLocalOpen(true);
  }, [active, expanded]);
  const open = expanded ?? localOpen;
  const toggle = (): void => {
    if (onToggle) onToggle();
    else setLocalOpen((current) => !current);
  };
  const hasChildren = entry.children.length > 0 || (entry.borrowed?.length ?? 0) > 0;
  const listId = `wx-nav-${entry.key}`;
  return (
    <div className="wx-nav-entry">
      <div className="wx-nav-row">
        <Link
          to={entry.href ?? "/"}
          className={active ? "wx-nav-link active" : "wx-nav-link"}
          aria-current={active && pathname === entry.href ? "page" : undefined}
          aria-expanded={hasChildren ? open : undefined}
          aria-controls={hasChildren ? listId : undefined}
          onClick={() => {
            if (hasChildren) toggle();
          }}
        >
          <Glyph name={entry.icon} size={18} strokeWidth={1.75} />
          <span>{entry.label}</span>
        </Link>
        {hasChildren ? (
          <button
            type="button"
            className="wx-nav-disclosure"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={`${open ? "Hide" : "Show"} ${entry.label} pages`}
            onClick={toggle}
          >
            <Glyph name={open ? "chevron-down" : "chevron-right"} size={16} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {hasChildren && open ? (
        <div id={listId}>
          {/* Screens in no subsection (or every screen, for entries without subsections). */}
          <NavLinkList
            links={entry.children.filter(
              (c) => !entry.subsections?.some((sub) => sub.screens.some((s) => s.path === c.path)),
            )}
            pathname={pathname}
          />
          {entry.subsections?.map((sub) => (
            <NavSubsection
              key={sub.key}
              sub={sub}
              entry={entry}
              listId={listId}
              pathname={pathname}
            />
          ))}
          {entry.borrowed?.length ? (
            <NavLinkList links={[]} borrowed={entry.borrowed} pathname={pathname} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A collapsible sub-section (Medicare / Medicaid / Commercial). */
function NavSubsection({
  sub,
  entry,
  listId,
  pathname,
}: {
  sub: NonNullable<NavEntry["subsections"]>[number];
  entry: NavEntry;
  listId: string;
  pathname: string;
}): JSX.Element | null {
  const links = sub.screens.filter((s) => s.path !== entry.href);
  // Prefix match, like the parent entry, so a detail route (/x/:id) opens the section that owns /x.
  const hasActive = links.some((s) => pathname === s.path || pathname.startsWith(`${s.path}/`));
  const [open, setOpen] = useState(hasActive);
  // Opens when the current page moves into the section; a manual collapse sticks until it moves out and back.
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);
  if (links.length === 0 && sub.borrowed.length === 0) return null;
  const labelId = `${listId}-${sub.key}`;
  const bodyId = `${labelId}-links`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group, not a <fieldset> (no form controls); pinned by primary-nav-entry.dom.test.tsx.
    <div role="group" aria-labelledby={labelId}>
      <button
        type="button"
        id={labelId}
        className="wx-nav-section-label wx-nav-subsection-label wx-nav-subsection-toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{sub.label}</span>
        <Glyph name={open ? "chevron-down" : "chevron-right"} size={14} strokeWidth={1.75} />
      </button>
      {open ? (
        <div id={bodyId}>
          <NavLinkList links={links} borrowed={sub.borrowed} pathname={pathname} />
        </div>
      ) : null}
    </div>
  );
}

/** Owned links (active highlight + aria-current) then borrowed ones (plain links: the owner is current). */
function NavLinkList({
  links,
  borrowed = [],
  pathname,
}: {
  links: NavScreen[];
  borrowed?: NavScreen[];
  pathname: string;
}): JSX.Element | null {
  if (links.length === 0 && borrowed.length === 0) return null;
  return (
    <ul className="wx-nav-children">
      {links.map((c) => (
        <li key={c.id}>
          <Link
            to={c.path}
            className={pathname === c.path ? "wx-nav-child active" : "wx-nav-child"}
            aria-current={pathname === c.path ? "page" : undefined}
          >
            {c.title}
          </Link>
        </li>
      ))}
      {borrowed.map((c) => (
        <li key={`borrowed:${c.id}`}>
          <Link to={c.path} className="wx-nav-child">
            {c.title}
          </Link>
        </li>
      ))}
    </ul>
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
  const inputRef = useRef<HTMLInputElement>(null);
  // ⌘K / Ctrl+K focuses the search from anywhere (the hint chip advertises it).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  function submit(e: FormEvent): void {
    e.preventDefault();
    setSearchTerm(q);
    navigate("/search");
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on the form is the intended, widely-supported pattern.
    <form className="wx-topnav-search" onSubmit={submit} role="search">
      <span className="wx-topnav-search-icon" aria-hidden>
        <Glyph name="search" size={18} strokeWidth={1.75} />
      </span>
      <input
        ref={inputRef}
        type="search"
        aria-label="Global search"
        placeholder="Search patients, staff, orders, documents..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <kbd className="wx-topnav-search-kbd" aria-hidden>
        ⌘ K
      </kbd>
    </form>
  );
}

/**
 * The signed-in actor's name — a discoverable sign-out control, not inert text (live-browser
 * audit #6: before this, the only `signOut()` call in the app was buried in the idle screen-lock's
 * "Sign out instead" escape hatch, so a user finishing a shift on a shared clinical workstation had
 * no direct in-app way to end their session).
 */
export function ActorMenu({ session }: { session: Session | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [signOutFailed, setSignOutFailed] = useState(false);
  useDisclosureDismiss(open, () => setOpen(false), ref, triggerRef);

  async function signOut(): Promise<void> {
    setSignOutFailed(false);
    try {
      await signOutOfAuth();
      clearAllDrafts();
      clearPendingNotificationLink();
    } catch {
      // Not signed out: stay here and say so. Navigating to /login anyway could bounce straight back into a live session
      // on a shared workstation while the user believes they have left.
      setSignOutFailed(true);
      return;
    }
    setOpen(false);
    window.location.href = "/login";
  }

  if (!session) {
    return <span className="wx-actor">Not signed in</span>;
  }

  const displayName = session.displayName ?? session.userId;
  const role = roleLine(session);

  return (
    <div className="wx-actor" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="wx-actor-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // The name text is display:none below 768px, so the button names itself (label-in-name keeps the visible name).
        aria-label={`${displayName}${role ? `, ${role}` : ""}, account menu`}
      >
        <span className="wx-actor-avatar" aria-hidden>
          {getInitials(displayName)}
        </span>
        <span className="wx-actor-text">
          <span className="wx-actor-name">{displayName}</span>
          {role ? <span className="wx-actor-role">{role}</span> : null}
        </span>
        <Glyph name="chevron-down" size={16} strokeWidth={1.75} />
      </button>
      {open ? (
        <div className="wx-actor-menu">
          <button type="button" className="wx-actor-menu-item" onClick={() => void signOut()}>
            Sign out
          </button>
          {signOutFailed ? (
            <InlineAlert tone="error">Could not sign out. Try again.</InlineAlert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Light ⇄ dark toggle (DESIGN.md §11). Persists the choice; sun in dark, moon in light. */
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
      <Glyph name={dark ? "sun" : "moon"} size={20} strokeWidth={1.75} />
    </button>
  );
}

/** Default landing screen until module screens are registered. */
export function HomeScreen(): JSX.Element {
  return (
    <EmptyState
      title="ChartWarden"
      description="The app shell is running. Module screens appear here as they are registered."
    />
  );
}
