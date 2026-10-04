// apps/web/src/modules/06-admission — the Admissions area chrome shared by its tabbed list pages
// (All Admissions, Pending Referrals): the sub-tab bar, KPI stat cards, labeled filter selects and
// the initials avatar, so every tab of the area lays out the same way.
import { Glyph, type GlyphName, t } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";

const TABS = [
  { to: "/admissions", label: "All Admissions" },
  { to: "/referrals", label: "Pending Referrals" },
  { to: "/compliance/admissions", label: "Compliance Windows" },
] as const;

export function AdmissionsTabs({ current }: { current: (typeof TABS)[number]["to"] }): JSX.Element {
  return (
    <nav className="wx-subtabs" aria-label="Admissions views">
      {TABS.map((tab) =>
        tab.to === current ? (
          <Link key={tab.to} to={tab.to} aria-current="page" className="is-current">
            {tab.label}
          </Link>
        ) : (
          <Link key={tab.to} to={tab.to}>
            {tab.label}
          </Link>
        ),
      )}
    </nav>
  );
}

const AVATAR_TINTS = [
  "var(--color-viz-blue)",
  "var(--color-viz-green)",
  "var(--color-viz-violet)",
  "var(--color-viz-amber)",
  "var(--color-viz-teal)",
  "var(--color-viz-pink)",
];
function tintFor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}
function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

export function Stat({
  icon,
  value,
  label,
  hint,
  color = t.primary,
  onSelect,
  selected = false,
}: {
  icon: GlyphName;
  value: number;
  label: string;
  hint: string;
  color?: string;
  /** Makes the card a filter toggle (e.g. "show only overdue"). */
  onSelect?: () => void;
  selected?: boolean;
}): JSX.Element {
  const body = (
    <>
      <span
        aria-hidden
        className="wx-stat-icon"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})` }}
      >
        <Glyph name={icon} size={22} strokeWidth={1.6} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="wx-stat-label">{label}</span>
        <strong className="wx-stat-value wx-nums">{value}</strong>
        <span className="wx-stat-label">{hint}</span>
      </span>
    </>
  );
  return onSelect ? (
    <button
      type="button"
      className={`wx-stat-card wx-stat-card-button${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {body}
    </button>
  ) : (
    <div className="wx-stat-card">{body}</div>
  );
}

export function Filter({
  label,
  value,
  onChange,
  ariaLabel,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="wx-filter-field">
      <span>{label}</span>
      <select
        className="wx-select"
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

export function Avatar({ name, size }: { name: string; size?: "lg" }): JSX.Element {
  const c = tintFor(name);
  return (
    <span
      className={`wx-home-avatar${size === "lg" ? " wx-avatar-lg" : ""}`}
      aria-hidden
      style={{
        color: `color-mix(in srgb, ${c} 60%, ${t.onSurface})`,
        background: `color-mix(in srgb, ${c} 14%, ${t.surfaceLowest})`,
      }}
    >
      {initials(name)}
    </span>
  );
}
