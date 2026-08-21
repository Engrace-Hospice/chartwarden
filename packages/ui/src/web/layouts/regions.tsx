// @wardenx/ui — Tier-1 layout regions (F0-T04, ADR-0030; Lantern-enforced R0.2).
// The recurring zones from WARDENX_UI_LAYOUT_PATTERNS.md §"Tier 1 — Shared regions": slot-based,
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
import { ghostBorder, t } from "../theme/tokens";

/** Page Header — screen title, breadcrumb, page-level actions. */
export interface PageHeaderProps {
  title: ReactNode;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}
export function PageHeader({ title, breadcrumb, actions, children }: PageHeaderProps): JSX.Element {
  return (
    <header
      className="wx-page-header"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: t.space2,
        padding: `${t.space4} ${t.space5}`,
        borderBottom: ghostBorder,
      }}
    >
      {breadcrumb ? (
        <div className="wx-breadcrumb" style={{ fontSize: "0.8rem", color: t.onSurfaceVariant }}>
          {breadcrumb}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: t.space4,
        }}
      >
        {/* headline-lg — Fraunces, the human voice for the screen title (§3.1). */}
        <h1
          className="wx-page-title"
          style={{
            margin: 0,
            fontFamily: t.fontDisplay,
            fontSize: "1.75rem",
            fontWeight: 500,
            lineHeight: 1.2,
            color: t.onSurface,
          }}
        >
          {title}
        </h1>
        {actions ? (
          <div className="wx-page-actions" style={{ display: "flex", gap: t.space2 }}>
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

/** KPI Strip — horizontal row of summary metric cards. */
export function KpiStrip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="wx-kpi-strip"
      style={{
        display: "flex",
        flexShrink: 0,
        gap: t.space4,
        padding: `${t.space4} ${t.space5}`,
        overflowX: "auto",
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
  /** Optional left accent rail for dashboard/work-queue KPI cards. */
  accentColor?: string;
  /** Optional click → e.g. apply a saved filter into the queue below. */
  onSelect?: () => void;
}
export function KpiCard({
  label,
  value,
  detail,
  trend,
  tone = "neutral",
  selected = false,
  accentColor,
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
            : t.onSurface;
  const body = (
    <>
      {/* label-sm — Fraunces eyebrow, all-caps (§3.3 Big/Small editorial rule). */}
      <div
        style={{
          fontFamily: t.fontDisplay,
          fontSize: "0.6875rem",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: t.onSurfaceVariant,
        }}
      >
        {label}
      </div>
      {/* The figure — Inter with tabular-nums; never Fraunces (its numerals aren't tabular). */}
      <div
        style={{
          fontFamily: t.fontSans,
          fontSize: "1.5rem",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: semantic,
        }}
      >
        {value}
      </div>
      {detail || trend ? (
        <div
          style={{ display: "flex", gap: t.space2, color: t.onSurfaceVariant, fontSize: "0.75rem" }}
        >
          {detail}
          {trend ? <span style={{ color: semantic, fontWeight: 600 }}>{trend}</span> : null}
        </div>
      ) : null}
    </>
  );
  // No-Line card: surface-lowest fill + soft shadow + xl radius, no border (§2.5/§4.3).
  const style = {
    minWidth: "10rem",
    padding: `${t.space3} ${t.space4}`,
    background: t.surfaceLowest,
    borderRadius: t.radiusXl,
    boxShadow: t.shadowSoft,
    textAlign: "left" as const,
    border: selected ? `2px solid ${t.primary}` : "2px solid transparent",
    borderLeft: accentColor ? `4px solid ${accentColor}` : undefined,
  };
  return onSelect ? (
    <button
      type="button"
      className="wx-kpi-card"
      onClick={onSelect}
      aria-pressed={selected}
      style={{ ...style, cursor: "pointer" }}
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
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        padding: "0.75rem 1.5rem",
        borderBottom: ghostBorder,
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>{children}</div>
      {actions || activeFilterCount > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {activeFilterCount > 0 ? (
            <span style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>
              {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
            </span>
          ) : null}
          {onClear ? (
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
  // R2 — reconciled to the P0 patient-chart frame (wardenx-P0-foundation.pen `fQjjh`): an identity
  // avatar, a secondary meta line under the name, an explicit chips row (status/identifier/alert
  // pills supplied by the caller), and a right-aligned actions slot. All optional — when omitted the
  // banner falls back to the original label/value fields, so existing call sites render unchanged.
  avatar?: ReactNode;
  meta?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
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
  return (
    <div
      className="wx-patient-banner"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        display: "flex",
        flexWrap: "wrap",
        gap: "1rem",
        alignItems: "center",
        padding: "0.625rem 1.5rem",
        background: t.surfaceLowest,
        borderBottom: ghostBorder,
      }}
    >
      {avatarNode ? (
        <div
          aria-hidden
          className="wx-banner-avatar"
          style={{
            width: "2.75rem",
            height: "2.75rem",
            flexShrink: 0,
            borderRadius: "9999px",
            background: t.primaryTint,
            color: t.primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: t.fontDisplay,
            fontWeight: 600,
            fontSize: "1rem",
          }}
        >
          {avatarNode}
        </div>
      ) : null}

      {/* headline-md — the patient name in Fraunces, the human anchor of the chart (§3.3) — over an
          optional meta line (DOB · age · sex · pronouns) in the Inter functional voice. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
        <strong
          className="wx-banner-name"
          style={{
            fontFamily: t.fontDisplay,
            fontSize: "1.25rem",
            fontWeight: 500,
            color: t.onSurface,
            lineHeight: 1.1,
          }}
        >
          {name}
        </strong>
        {meta ? (
          <span style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>{meta}</span>
        ) : null}
      </div>

      {/* Chips row — caller-supplied identity/status/alert pills; falls back to the original fields. */}
      <div
        className="wx-banner-chips"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.5rem",
          flex: 1,
          minWidth: 0,
        }}
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

      {actions ? (
        <div
          className="wx-banner-actions"
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
