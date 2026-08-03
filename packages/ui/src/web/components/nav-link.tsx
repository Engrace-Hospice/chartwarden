// @wardenx/ui — NavLink + navGroup sections (UI-001). The primary shell sidebar mapped plain
// react-router `Link`s over a flat screen list: no active-state signal (the `[aria-current="page"]`
// CSS in apps/web/src/index.css was dead code — nothing ever set it) and no use of the `navGroup`
// label 35 module screen-sets already declare. `NavLink` wraps react-router's own `NavLink` (every
// @wardenx/ui web consumer — apps/web, apps/portal, apps/admin — already depends on
// react-router-dom@^6), which sets `aria-current="page"` on the active route for free. `NavGroup` +
// `groupByNavGroup` give the sidebar the same collapsible-by-group structure `RoleHome` already uses.
import { useId, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { NavLink as RouterNavLink } from "react-router-dom";
import { t } from "../theme/tokens";

export interface NavLinkProps {
  to: string;
  children: ReactNode;
  /** Exact-match only (passthrough to react-router's `end`). Default false. */
  end?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** A sidebar/nav item that sets `aria-current="page"` and an `active` class when its route matches. */
export function NavLink({ to, children, end, className, style }: NavLinkProps): JSX.Element {
  return (
    <RouterNavLink
      to={to}
      end={end}
      style={style}
      className={({ isActive }) =>
        [className, isActive ? "active" : undefined].filter(Boolean).join(" ")
      }
    >
      {children}
    </RouterNavLink>
  );
}

export interface NavGroupProps {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

/** A collapsible labeled section of `NavLink`s (mirrors the grouping `RoleHome` already applies). */
export function NavGroup({ label, children, defaultOpen = true }: NavGroupProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className="wx-nav-group">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "0.4rem 0.75rem",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: "0.7rem",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: t.muted,
        }}
      >
        {label}
        <span aria-hidden style={{ fontSize: "0.65rem" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>
      <div id={contentId} hidden={!open} style={{ display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

/** Groups items by their `navGroup` (default `"General"`), sorted alphabetically by group label. */
export function groupByNavGroup<T extends { navGroup?: string }>(
  items: T[],
  fallback = "General",
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.navGroup ?? fallback;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
