// @wardenx/ui — NavLink + navGroup sections (UI-001).
import React, { useId, useState, useEffect } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { NavLink as RouterNavLink, useLocation } from "react-router-dom";
import { Glyph, type GlyphName } from "../system/glyphs";
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

function getGroupIcon(label: string): GlyphName {
  const l = label.toLowerCase();
  if (l.includes("clinical")) return "heart";
  if (l.includes("billing")) return "dollar";
  if (l.includes("compliance")) return "clipboard-check";
  if (l.includes("supplies")) return "truck";
  if (l.includes("scheduling")) return "calendar";
  if (l.includes("admin")) return "settings";
  return "folder";
}

/** A collapsible labeled section of `NavLink`s (mirrors the grouping `RoleHome` already applies). */
export function NavGroup({ label, children, defaultOpen = true }: NavGroupProps): JSX.Element {
  const location = useLocation();
  const contentId = useId();

  // Check if any of the children are active
  const isChildActive = React.Children.toArray(children).some((child) => {
    if (React.isValidElement(child) && child.props && typeof child.props.to === "string") {
      const to = child.props.to;
      return location.pathname === to || (to !== "/" && location.pathname.startsWith(to));
    }
    return false;
  });

  const [open, setOpen] = useState(isChildActive || defaultOpen);

  // Automatically open the active group, and close it when we switch to another active group
  useEffect(() => {
    setOpen(isChildActive);
  }, [location.pathname, isChildActive]);

  return (
    <div
      className={`wx-nav-group ${isChildActive ? "active" : ""}`}
      style={{ transition: "all 0.2s ease" }}
    >
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
          padding: "0.5rem 0.75rem",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: "0.75rem",
          fontWeight: isChildActive ? 700 : 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: isChildActive ? "var(--color-primary)" : "var(--color-muted)",
          transition: "all 0.2s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Glyph
            name={getGroupIcon(label)}
            size={14}
            style={{
              color: isChildActive ? "var(--color-primary)" : "var(--color-muted)",
              opacity: isChildActive ? 1 : 0.7,
              transition: "all 0.2s ease",
            }}
          />
          <span>{label}</span>
        </div>
        <span
          aria-hidden
          style={{
            fontSize: "0.65rem",
            transition: "transform 0.2s ease",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
          }}
        >
          ▾
        </span>
      </button>
      <div id={contentId} className={`wx-nav-group-content ${open ? "open" : ""}`}>
        <div style={{ display: "flex", flexDirection: "column", paddingLeft: "0.5rem" }}>
          {children}
        </div>
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
