import {
  Glyph,
  InlineAlert,
  SkipLink,
  discardStepUpDrafts,
  useDisclosureDismiss,
  useOffCanvasNav,
  useTheme,
} from "@chartwarden/ui";
// apps/admin/src/shell — the Platform-Ops console frame in the clinical app's 2026-09-25 redesign: a full-height
// sidebar (brand + grouped nav, admin-nav.ts) beside a column holding the top bar and the routed screen. The markup
// and `wx-shell` classes match apps/web/src/shell/layout.tsx; the rules live in packages/ui/src/web/styles/app-shell.css,
// which both apps import. Imports no module slice (ADR-0030) — the nav is derived from the registered screens.
import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { type AdminNavSection, activeAdminEntry } from "./admin-nav";
import { authClient } from "./auth-client";
import type { Session } from "./session";
import { useSession } from "./session";

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s,._@-]+/)
    .filter(Boolean);
  const [first, second] = parts;
  if (!first) return "U";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0]}${second[0]}`.toUpperCase();
}

export function AdminLayout({ sections }: { sections: readonly AdminNavSection[] }): JSX.Element {
  const session = useSession();
  // Below 768px the sidebar is an off-canvas drawer toggled by the header's menu button (app-shell.css).
  const { navOpen, setNavOpen, closeForNavigation, sidebarRef, toggleRef } = useOffCanvasNav(
    () => mainRef.current,
  );
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // `.wx-main` is the scroll container, so a route change would otherwise keep the previous page's scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intentional trigger, not read in the body.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);
  const activeKey = activeAdminEntry(sections, pathname);

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
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: closes the mobile nav when a (keyboard-reachable) nav link is
          clicked; the aside itself is not a control. */}
      <aside
        id="wx-admin-sidebar"
        ref={sidebarRef}
        className={navOpen ? "wx-sidebar wx-nav-open" : "wx-sidebar"}
        onClick={closeNavOnLinkClick}
      >
        <Link to="/" className="wx-brand-block" aria-label="ChartWarden Platform Ops home">
          <span className="wx-brand-logo" aria-hidden>
            <img src="/chartwarden-mark.svg" width="28" height="28" alt="" />
          </span>
          <span className="wx-brand-text">
            <span className="wx-brand">ChartWarden</span>
            <span className="wx-brand-sub">Platform Ops</span>
          </span>
        </Link>
        <nav id="wx-admin-nav" className="wx-nav wx-no-scrollbar" aria-label="Platform operations">
          {sections.map((section) => (
            <div key={section.label ?? "main"} className="wx-nav-section">
              {section.label ? <div className="wx-nav-section-label">{section.label}</div> : null}
              {section.entries.map((entry) => {
                const active = entry.key === activeKey;
                return (
                  <div key={entry.key} className="wx-nav-row">
                    <Link
                      to={entry.to}
                      className={active ? "wx-nav-link active" : "wx-nav-link"}
                      aria-current={active && pathname === entry.to ? "page" : undefined}
                    >
                      <Glyph name={entry.icon} size={18} strokeWidth={1.75} />
                      <span>{entry.label}</span>
                    </Link>
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <div className="wx-shell-column">
        <header className="wx-header">
          <button
            ref={toggleRef}
            type="button"
            className="wx-icon-btn wx-nav-toggle"
            onClick={() => setNavOpen((open) => !open)}
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            aria-controls="wx-admin-sidebar"
          >
            <Glyph name={navOpen ? "close" : "menu"} size={18} />
          </button>
          <div className="wx-header-actions">
            <ThemeToggle />
            <ActorMenu session={session} />
          </div>
        </header>
        <main id="wx-main" className="wx-main wx-no-scrollbar" ref={mainRef} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** The signed-in operator, with Sign out (the console had no way to end a session). */
export function ActorMenu({ session }: { session: Session | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [signOutFailed, setSignOutFailed] = useState(false);

  useDisclosureDismiss(open, () => setOpen(false), ref, triggerRef);

  async function signOut(): Promise<void> {
    setSignOutFailed(false);
    try {
      await authClient.signOut();
    } catch {
      // Not signed out: stay here and say so. Navigating to /login anyway could bounce straight back into a live session
      // on a shared workstation while the user believes they have left.
      setSignOutFailed(true);
      return;
    }
    discardStepUpDrafts(); // a typed form must not outlive the session that typed it
    setOpen(false);
    window.location.href = "/login";
  }

  if (!session) return <span className="wx-actor">Not signed in</span>;
  const displayName = session.displayName ?? session.userId;

  return (
    <div className="wx-actor" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="wx-actor-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // The name text is display:none below 768px, so the button names itself (label-in-name keeps the visible name).
        aria-label={`${displayName}, Platform operations, account menu`}
      >
        <span className="wx-actor-avatar" aria-hidden>
          {initials(displayName)}
        </span>
        <span className="wx-actor-text">
          <span className="wx-actor-name">{displayName}</span>
          <span className="wx-actor-role">Platform operations</span>
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

/** Light ⇄ dark toggle, shared with the clinical app (the same `wx-theme` preference). */
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
