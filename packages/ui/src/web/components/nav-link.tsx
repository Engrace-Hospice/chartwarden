// @chartwarden/ui — NavLink + navGroup sections (UI-001).
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
