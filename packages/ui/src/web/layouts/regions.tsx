// @chartwarden/ui — Tier-1 layout regions (F0-T04, ADR-0030; Lantern-enforced R0.2).
// The recurring zones from CHARTWARDEN_UI_LAYOUT_PATTERNS.md §"Tier 1 — Shared regions": slot-based,
// presentational, no business logic. The foundational pattern layouts (patterns.tsx) and the
// module screens compose these so layout is defined once, here.
//
// Lantern (DESIGN.md): tokens only — no hardcoded hex (theme-reactive incl. twilight dark mode);
// No-Line (§10) — region edges are tonal surface shifts or a ghost border at ≤15% opacity, never
// an opaque 1px rule; type voices (§3) — Fraunces for human moments (titles, names, KPI labels),
// Inter for the work (data, numerals with tabular-nums), IBM Plex Mono for identifiers/codes.
import { useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { Button } from "../components/button";
import { Glyph, type GlyphName } from "../system/glyphs";
import { ghostBorder, t } from "../theme/tokens";

/** Page Header — screen title and page-level actions. Route breadcrumbs live in the shell. */
export interface PageHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}
// 2026-10-04 — matches the redesigned list pages (Admissions, its Pending Referrals / Compliance tabs):
// a bold sans title over the canvas, no divider rule; the KPI cards and filter panel below carry the
// structure.
export function PageHeader({ title, actions, children }: PageHeaderProps): JSX.Element {
  return (
    <header
      className="wx-page-header"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: t.space1,
        padding: `${t.space5} ${t.space5} ${t.space2}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: t.space4,
        }}
      >
        <h1
          className="wx-page-title"
          style={{
            margin: 0,
            fontFamily: t.fontSans,
            fontSize: "1.875rem",
            fontWeight: 700,
            letterSpacing: "-0.01em",
            lineHeight: 1.2,
            color: t.onSurface,
          }}
        >
          {title}
        </h1>
        {actions ? (
          <div
            className="wx-page-actions"
            style={{ display: "flex", flexWrap: "wrap", gap: t.space2 }}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

/** KPI Strip — row of summary metric cards; the cards share the row's width. */
export function KpiStrip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="wx-kpi-strip"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(12.5rem, 1fr))",
        flexShrink: 0,
        gap: t.space4,
        padding: `${t.space4} ${t.space5}`,
      }}
    >
      {children}
    </div>
  );
}

export interface KpiCardProps {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  selected?: boolean;
  /** Overrides the tone's icon colour. */
  accentColor?: string;
  /** Icon in the tinted square; defaults to one per tone. */
  icon?: GlyphName;
  /** Optional click → e.g. apply a saved filter into the queue below. */
  onSelect?: () => void;
}
const TONE_ICON: Record<NonNullable<KpiCardProps["tone"]>, GlyphName> = {
  neutral: "bar-chart",
  info: "file-text",
  success: "check-circle",
  warning: "clock",
  danger: "alert-circle",
};
// 2026-10-04 — the redesigned stat card (Admissions): a tone-tinted icon square, a sentence-case label,
// the figure, and its detail line, on a bordered card.
export function KpiCard({
  label,
  value,
  detail,
  trend,
  tone = "neutral",
  selected = false,
  accentColor,
  icon,
  onSelect,
}: KpiCardProps): JSX.Element {
  const semantic =
    tone === "info"
      ? t.primary
      : tone === "success"
        ? t.success
        : tone === "warning"
          ? t.warning
          : tone === "danger"
            ? t.error
            : t.primary;
  // Callers pass the outline grey to mean "no accent" (it was the old left rail's quiet colour); as an
  // icon colour it would vanish, so it reads as neutral here.
  const color =
    accentColor && !accentColor.includes("outline")
      ? accentColor
      : accentColor
        ? t.onSurfaceVariant
        : semantic;
  const body = (
    <>
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: "2.75rem",
          height: "2.75rem",
          borderRadius: t.radiusMd,
          color,
          background: `color-mix(in srgb, ${color} 12%, ${t.surfaceLowest})`,
        }}
      >
        <Glyph name={icon ?? TONE_ICON[tone]} size={22} strokeWidth={1.6} />
      </span>
      <span style={{ display: "grid", minWidth: 0 }}>
        <span style={{ color: t.muted, fontSize: "0.8125rem" }}>{label}</span>
        {/* The figure — tabular numerals. */}
        <span
          style={{
            fontFamily: t.fontSans,
            fontSize: "1.625rem",
            fontWeight: 700,
            lineHeight: 1.2,
            fontVariantNumeric: "tabular-nums",
            color: t.onSurface,
          }}
        >
          {value}
        </span>
        {detail || trend ? (
          <span style={{ display: "flex", gap: t.space2, color: t.muted, fontSize: "0.8125rem" }}>
            {detail}
            {trend ? <span style={{ color: semantic, fontWeight: 600 }}>{trend}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );
  const style = {
    display: "flex",
    alignItems: "center",
    gap: "0.875rem",
    minWidth: 0,
    padding: "1rem 1.125rem",
    background: t.surfaceLowest,
    border: `1px solid ${selected ? t.primary : t.cardBorder}`,
    borderRadius: t.radiusLg,
    boxShadow: selected ? `inset 0 0 0 1px ${t.primary}` : undefined,
    textAlign: "left" as const,
    font: "inherit",
    color: "inherit",
  };
  return onSelect ? (
    <button
      type="button"
      className="wx-kpi-card"
      onClick={onSelect}
      aria-pressed={selected}
      style={{ ...style, width: "100%", cursor: "pointer" }}
    >
      {body}
    </button>
  ) : (
    <div className="wx-kpi-card" style={style}>
      {body}
    </div>
  );
}

/** Filter Bar — inline filter/search controls above a table. */
export interface FilterBarProps {
  children: ReactNode;
  actions?: ReactNode;
  /** Visible count keeps applied filtering understandable without encoding it in a color. */
  activeFilterCount?: number;
  onClear?: () => void;
}
export function FilterBar({
  children,
  actions,
  activeFilterCount = 0,
  onClear,
}: FilterBarProps): JSX.Element {
  return (
    <div
      className="wx-filter-bar"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: "0.75rem",
        // No outer margin: a work queue's filter slot (.wx-work-filters) or the page's own content
        // padding supplies the gutter.
        padding: "0.875rem 1rem",
        background: t.surfaceLowest,
        border: `1px solid ${t.cardBorder}`,
        borderRadius: t.radiusLg,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: "0.75rem", flexWrap: "wrap" }}>
        {children}
      </div>
      {actions || activeFilterCount > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {activeFilterCount > 0 ? (
            <span style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>
              {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
            </span>
          ) : null}
          {onClear && activeFilterCount > 0 ? (
            <Button tone="tertiary" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Left Nav Rail — navigation within a screen (steps, settings sidebar, worksheet tree). */
export function LeftNavRail({
  children,
  ariaLabel = "Section navigation",
}: { children: ReactNode; ariaLabel?: string }): JSX.Element {
  return (
    <nav
      className="wx-left-rail"
      aria-label={ariaLabel}
      style={{
        width: "16rem",
        flexShrink: 0,
        // Tonal separation: the rail sits on surface-lowest over the page canvas, plus a ghost edge.
        background: t.surfaceLowest,
        borderRight: ghostBorder,
        overflowY: "auto",
        padding: "1rem",
      }}
    >
      {children}
    </nav>
  );
}

/** Right Detail Panel — right-docked detail for the selected row/record. Collapses when closed. */
export interface RightDetailPanelProps {
  open?: boolean;
  title?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  /** Keeps a scrollable panel usable while visually hiding its scrollbar. */
  hideScrollbar?: boolean;
}
export function RightDetailPanel({
  open = true,
  title,
  onClose,
  children,
  hideScrollbar = false,
}: RightDetailPanelProps): JSX.Element | null {
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!open || !onClose) return;
    openerRef.current = document.activeElement;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <aside
      className={`wx-right-panel${hideScrollbar ? " wx-no-scrollbar" : ""}`}
      aria-label={typeof title === "string" ? title : "Detail panel"}
      style={{
        width: "24rem",
        flexShrink: 0,
        background: t.surfaceLowest,
        borderLeft: ghostBorder,
        overflowY: "auto",
        padding: "1rem",
      }}
    >
      {(title || onClose) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.75rem",
          }}
        >
          {/* title-md — Inter section header (§3.2). */}
          <div style={{ fontFamily: t.fontSans, fontWeight: 600, color: t.onSurface }}>{title}</div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close detail panel"
              style={{
                cursor: "pointer",
                color: t.onSurfaceVariant,
                border: "none",
                background: "none",
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      )}
      {children}
    </aside>
  );
}

/** Sticky Footer Actions — pinned action bar (Save / Complete / Sign / Next). */
export function StickyFooterActions({ children }: { children: ReactNode }): JSX.Element {
  return (
    <footer
      className="wx-sticky-footer"
      style={{
        position: "sticky",
        bottom: 0,
        display: "flex",
        justifyContent: "flex-end",
        gap: "0.5rem",
        padding: "0.75rem 1.5rem",
        borderTop: ghostBorder,
        background: t.surfaceLowest,
      }}
    >
      {children}
    </footer>
  );
}

/** Patient Banner — persistent patient-identity strip; required on clinical screens, sticky on scroll. */
export interface PatientBannerProps {
  name: ReactNode;
  mrn?: ReactNode;
  dob?: ReactNode;
  codeStatus?: ReactNode;
  allergies?: ReactNode;
  benefitPeriod?: ReactNode;
  // R2 — reconciled to the P0 patient-chart frame (chartwarden-P0-foundation.pen `fQjjh`): an identity
  // avatar, a secondary meta line under the name, an explicit chips row (status/identifier/alert
  // pills supplied by the caller), and a right-aligned actions slot. All optional — when omitted the
  // banner falls back to the original label/value fields, so existing call sites render unchanged.
  avatar?: ReactNode;
  meta?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  /** Render the name as the page's `<h1>`; set it only on chart pages that have no other h1. */
  nameAsHeading?: boolean;
}
export function PatientBanner({
  name,
  mrn,
  dob,
  codeStatus,
  allergies,
  benefitPeriod,
  avatar,
  meta,
  chips,
  actions,
  nameAsHeading,
}: PatientBannerProps): JSX.Element {
  const field = (label: string, value: ReactNode, mono = false): ReactNode =>
    value ? (
      <span className="wx-banner-field" style={{ color: t.onSurface }}>
        <span style={{ color: t.onSurfaceVariant, marginRight: "0.25rem" }}>{label}</span>
        {mono ? <span style={{ fontFamily: t.fontMono }}>{value}</span> : value}
      </span>
    ) : null;
  // Initials fallback for the avatar — only when `name` is a plain string (else the caller owns it).
  const initials =
    typeof name === "string"
      ? name
          .split(/[\s,]+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase() ?? "")
          .join("")
      : null;
  const avatarNode = avatar ?? initials;
  const NameTag = nameAsHeading ? "h1" : "strong";
  // 2026-09-25 redesign (mockups): a large tinted avatar, the name in bold with its status chip beside
  // it, the meta line below, actions right. The tab strip that follows draws the bottom rule.
  return (
    <div
      className="wx-patient-banner"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        display: "flex",
        flexWrap: "wrap",
        gap: "1rem",
        alignItems: "center",
        padding: "1.125rem 1.5rem 0.875rem",
        background: t.surfaceLowest,
      }}
    >
      {avatarNode ? (
        <div
          aria-hidden
          className="wx-banner-avatar"
          style={{
            width: "4rem",
            height: "4rem",
            flexShrink: 0,
            borderRadius: "9999px",
            background: t.primaryTint,
            color: t.primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: t.fontSans,
            fontWeight: 600,
            fontSize: "1.5rem",
          }}
        >
          {avatarNode}
        </div>
      ) : null}

      <div
        style={{ display: "flex", flexDirection: "column", gap: "0.3rem", minWidth: 0, flex: 1 }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.625rem" }}>
          <NameTag
            className="wx-banner-name"
            style={{
              margin: 0,
              fontFamily: t.fontSans,
              fontSize: "1.625rem",
              fontWeight: 700,
              letterSpacing: "-0.015em",
              color: t.onSurface,
              lineHeight: 1.15,
            }}
          >
            {name}
          </NameTag>
          {/* Chips — caller-supplied identity/status/alert pills; falls back to the original fields. */}
          <div
            className="wx-banner-chips"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}
          >
            {chips ?? (
              <>
                {/* MRN is an identifier → IBM Plex Mono (§3.1). */}
                {field("MRN", mrn, true)}
                {field("DOB", dob)}
                {field("Code", codeStatus)}
                {field("Allergies", allergies)}
                {field("Benefit period", benefitPeriod)}
              </>
            )}
          </div>
        </div>
        {meta ? (
          <span style={{ color: t.onSurfaceVariant, fontSize: "0.9375rem" }}>{meta}</span>
        ) : null}
      </div>

      {actions ? (
        <div
          className="wx-banner-actions"
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.625rem" }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
