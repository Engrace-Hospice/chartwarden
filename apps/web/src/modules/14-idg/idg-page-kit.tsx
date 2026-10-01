// apps/web/src/modules/14-idg — the org-level page anatomy shared by the IDG list screens. It is the
// SAME anatomy as Billing / Admissions (2026-09-25 redesign): `.wx-page-head` (30px h1 + subtitle +
// actions), an underline `.wx-subtabs` strip, a `.wx-stat-grid` of label-first `.wx-stat-card`s, a boxed
// `.wx-filter-panel` with a full-width search and labelled selects, and a `.wx-table-footer`. Only the
// shared classes from index.css are used, so a change to the kit changes these screens too.
import { Glyph, type GlyphName, t } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";

export function IdgPageHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="wx-page-head">
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: "1.875rem" }}>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {actions ? (
        <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>{actions}</div>
      ) : null}
    </header>
  );
}

/** Schedule | My Action Items — the module's sub-page strip (same pattern as Billing's Claims | Remittances …). */
export function IdgSubtabs({ current }: { current: "schedule" | "actions" }): JSX.Element {
  return (
    <nav className="wx-subtabs" aria-label="IDG views">
      <Link
        to="/idg/schedule"
        className={current === "schedule" ? "is-current" : undefined}
        aria-current={current === "schedule" ? "page" : undefined}
      >
        Schedule
      </Link>
      <Link
        to="/idg/action-items"
        className={current === "actions" ? "is-current" : undefined}
        aria-current={current === "actions" ? "page" : undefined}
      >
        My Action Items
      </Link>
    </nav>
  );
}

/** A KPI card: LABEL first, then the value, then a hint. */
export function IdgStat({
  icon,
  label,
  value,
  hint,
  color = t.primary,
}: {
  icon: GlyphName;
  label: string;
  value: ReactNode;
  hint: string;
  color?: string;
}): JSX.Element {
  return (
    <div className="wx-stat-card">
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})` }}
      >
        <Glyph name={icon} size={22} strokeWidth={1.6} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="wx-stat-label">{label}</div>
        <strong className="wx-stat-value wx-nums">{value}</strong>
        <div className="wx-stat-label">{hint}</div>
      </div>
    </div>
  );
}

/** A labelled select for the boxed filter panel. */
export function IdgFilter({
  label,
  ariaLabel,
  value,
  onChange,
  disabled,
  wide,
  children,
}: {
  label: string;
  ariaLabel?: string;
  wide?: boolean;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="wx-filter-field" style={wide ? { flexBasis: "21rem" } : undefined}>
      <span>{label}</span>
      <select
        className="wx-select"
        aria-label={ariaLabel ?? label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

/** The boxed search + selects bar. */
export function IdgFilterPanel({
  searchLabel,
  placeholder,
  search,
  onSearch,
  searchDisabled,
  onClear,
  children,
}: {
  searchLabel: string;
  placeholder: string;
  search: string;
  onSearch: (v: string) => void;
  searchDisabled?: boolean;
  onClear?: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="wx-filter-panel">
      <label className="wx-search-field">
        <Glyph name="search" size={16} />
        <input
          type="search"
          aria-label={searchLabel}
          placeholder={placeholder}
          value={search}
          disabled={searchDisabled}
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>
      {children}
      {onClear ? (
        <button type="button" className="wx-btn-secondary" onClick={onClear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

/** "Showing a to b of n <noun>" + Previous / Next, the sibling table footer. */
export function IdgTableFooter({
  page,
  pages,
  pageSize,
  total,
  noun,
  onPage,
}: {
  page: number;
  pages: number;
  pageSize: number;
  total: number;
  noun: string;
  onPage: (p: number) => void;
}): JSX.Element {
  return (
    <div className="wx-table-footer">
      <span className="wx-nums">
        Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, total)} of {total} {noun}
      </span>
      <span style={{ display: "inline-flex", gap: "0.375rem" }}>
        <button
          type="button"
          className="wx-btn-secondary wx-btn-sm"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="wx-btn-secondary wx-btn-sm"
          disabled={page === pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </span>
    </div>
  );
}

export const PAGE_SIZE = 10;

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
