// @wardenx/ui — Tier-1 layout regions (F0-T04, ADR-0030).
// The recurring zones from WARDENX_UI_LAYOUT_PATTERNS.md §"Tier 1 — Shared regions": slot-based,
// presentational, no business logic. The foundational pattern layouts (patterns.tsx) and the
// module screens compose these so layout is defined once, here.
import type { JSX, ReactNode } from "react";

const HAIRLINE = "1px solid #e5e7eb";

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
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "1rem 1.5rem", borderBottom: HAIRLINE }}
    >
      {breadcrumb ? (
        <div className="wx-breadcrumb" style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          {breadcrumb}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
        <h1 className="wx-page-title" style={{ margin: 0, fontSize: "1.25rem" }}>
          {title}
        </h1>
        {actions ? (
          <div className="wx-page-actions" style={{ display: "flex", gap: "0.5rem" }}>
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
      style={{ display: "flex", gap: "1rem", padding: "1rem 1.5rem", overflowX: "auto" }}
    >
      {children}
    </div>
  );
}

export interface KpiCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Optional click → e.g. apply a saved filter into the queue below. */
  onSelect?: () => void;
}
export function KpiCard({ label, value, onSelect }: KpiCardProps): JSX.Element {
  const body = (
    <>
      <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600 }}>{value}</div>
    </>
  );
  const style = { minWidth: "10rem", padding: "0.75rem 1rem", border: HAIRLINE, borderRadius: "0.5rem", textAlign: "left" as const };
  return onSelect ? (
    <button type="button" className="wx-kpi-card" onClick={onSelect} style={{ ...style, background: "#fff", cursor: "pointer" }}>
      {body}
    </button>
  ) : (
    <div className="wx-kpi-card" style={style}>
      {body}
    </div>
  );
}

/** Filter Bar — inline filter/search controls above a table. */
export function FilterBar({ children, actions }: { children: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div
      className="wx-filter-bar"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", padding: "0.75rem 1.5rem", borderBottom: HAIRLINE }}
    >
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>{children}</div>
      {actions ? <div style={{ display: "flex", gap: "0.5rem" }}>{actions}</div> : null}
    </div>
  );
}

/** Left Nav Rail — navigation within a screen (steps, settings sidebar, worksheet tree). */
export function LeftNavRail({ children, ariaLabel = "Section navigation" }: { children: ReactNode; ariaLabel?: string }): JSX.Element {
  return (
    <nav
      className="wx-left-rail"
      aria-label={ariaLabel}
      style={{ width: "16rem", flexShrink: 0, borderRight: HAIRLINE, overflowY: "auto", padding: "1rem" }}
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
}
export function RightDetailPanel({ open = true, title, onClose, children }: RightDetailPanelProps): JSX.Element | null {
  if (!open) return null;
  return (
    <aside
      className="wx-right-panel"
      style={{ width: "24rem", flexShrink: 0, borderLeft: HAIRLINE, overflowY: "auto", padding: "1rem" }}
    >
      {(title || onClose) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <div style={{ fontWeight: 600 }}>{title}</div>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Close detail panel" style={{ cursor: "pointer" }}>
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
      style={{ position: "sticky", bottom: 0, display: "flex", justifyContent: "flex-end", gap: "0.5rem", padding: "0.75rem 1.5rem", borderTop: HAIRLINE, background: "#fff" }}
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
}
export function PatientBanner({ name, mrn, dob, codeStatus, allergies, benefitPeriod }: PatientBannerProps): JSX.Element {
  const field = (label: string, value: ReactNode): ReactNode =>
    value ? (
      <span className="wx-banner-field">
        <span style={{ color: "#6b7280", marginRight: "0.25rem" }}>{label}</span>
        {value}
      </span>
    ) : null;
  return (
    <div
      className="wx-patient-banner"
      style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center", padding: "0.5rem 1.5rem", background: "#f9fafb", borderBottom: HAIRLINE }}
    >
      <strong className="wx-banner-name">{name}</strong>
      {field("MRN", mrn)}
      {field("DOB", dob)}
      {field("Code", codeStatus)}
      {field("Allergies", allergies)}
      {field("Benefit period", benefitPeriod)}
    </div>
  );
}
