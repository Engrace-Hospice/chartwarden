// @chartwarden/admin-ui-shell — the platform-ops console shell (M34 §3.1 / §5.1).
//
// The top-level chrome for the ChartWarden-staff control plane (`withPlatformContext` routes): a left
// nav rail over the eight platform-ops surfaces (Tenants / Support / Exports / Onboarding / Feature
// Flags / BAA / Signups / Key Rings — §5.1 inventory) and a top bar, with the active screen rendered
// in the content well. When a support session is open the host pins a SupportSessionBanner into the
// `sessionBanner` slot; it spans the whole shell above the top bar (§3.10, the one ambient-alert
// place).
//
// Lantern (DESIGN.md): tokens only — theme-reactive incl. twilight dark, zero hex; No-Line (§10) —
// the rail and top bar separate by a tonal `surface-lowest` shift plus a ghost edge, never a 1px
// rule; type voices (§3) — Fraunces for the product wordmark, Inter for nav labels. The shell owns
// only chrome; screens compose the @chartwarden/ui domain patterns (StatusBoard / WorkQueue / etc.).
import { ghostBorder, t } from "@chartwarden/ui";
import type { CSSProperties, JSX, ReactNode } from "react";

/** A single platform-ops nav destination. `key` is stable; `to` is the host router's path. */
export interface PlatformNavItem {
  key: string;
  label: ReactNode;
  to: string;
}

/**
 * The §5.1 platform-ops surfaces, in nav order. The shell ships this as its default rail; a host may
 * pass its own `nav` (e.g. to gate items by permission) but these are the canonical eight.
 */
export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  { key: "tenants", label: "Tenants", to: "/tenants" },
  { key: "support", label: "Support", to: "/support/sessions" },
  { key: "exports", label: "Exports", to: "/exports/dsar" },
  { key: "onboarding", label: "Onboarding", to: "/onboarding/templates" },
  { key: "feature-flags", label: "Feature Flags", to: "/feature-flags" },
  { key: "baa", label: "BAA", to: "/baa" },
  { key: "signups", label: "Signups", to: "/signups" },
  { key: "key-rings", label: "Key Rings", to: "/key-rings" },
];

export interface PlatformOpsShellProps {
  /** Persistent support-session banner, when a session is open — pinned above the top bar (§3.10). */
  sessionBanner?: ReactNode;
  /** Nav destinations. Defaults to the canonical PLATFORM_NAV_ITEMS (§5.1). */
  nav?: readonly PlatformNavItem[];
  /** The `key` of the active nav item — drives the selected (primary-tint) row. */
  activeKey?: string;
  /**
   * How the host renders a nav destination — typically a router `<Link to={item.to}>`. Kept as a
   * render prop so this package carries no router dependency. Falls back to a plain anchor.
   */
  renderNavLink?: (item: PlatformNavItem, active: boolean) => ReactNode;
  /** Top-bar trailing region — operator identity / session controls / theme toggle. */
  topBarActions?: ReactNode;
  /** Optional wordmark override; defaults to "ChartWarden Platform Ops". */
  brand?: ReactNode;
  /** The active screen. */
  children: ReactNode;
}

/** The platform-ops console frame: optional session banner → top bar → [nav rail | content]. */
export function PlatformOpsShell({
  sessionBanner,
  nav = PLATFORM_NAV_ITEMS,
  activeKey,
  renderNavLink,
  topBarActions,
  brand = "ChartWarden Platform Ops",
  children,
}: PlatformOpsShellProps): JSX.Element {
  return (
    <div
      className="wx-platform-ops-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: t.background,
      }}
    >
      {sessionBanner}
      <header
        className="wx-platform-topbar"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          padding: "0.625rem 1.25rem",
          background: t.surfaceLowest,
          borderBottom: ghostBorder,
        }}
      >
        {/* wordmark — Fraunces, the product's human voice (§3.1). */}
        <span
          className="wx-platform-brand"
          style={{
            fontFamily: t.fontDisplay,
            fontSize: "1.125rem",
            fontWeight: 600,
            color: t.onSurface,
          }}
        >
          {brand}
        </span>
        {topBarActions ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {topBarActions}
          </div>
        ) : null}
      </header>
      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <nav
          className="wx-platform-nav"
          aria-label="Platform operations"
          style={{
            width: "15rem",
            flexShrink: 0,
            background: t.surfaceLowest,
            borderRight: ghostBorder,
            overflowY: "auto",
            padding: "0.75rem",
          }}
        >
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.125rem",
            }}
          >
            {nav.map((item) => {
              const active = item.key === activeKey;
              return (
                <li key={item.key}>
                  {renderNavLink ? (
                    renderNavLink(item, active)
                  ) : (
                    <a
                      href={item.to}
                      style={navLinkStyle(active)}
                      aria-current={active ? "page" : undefined}
                    >
                      {item.label}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <main
          className="wx-platform-content"
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Default nav-link styling — primary-tint selected row, No-Line (the host may render its own link). */
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
