// @chartwarden/ui — domain Tier-2 pattern layouts (R0.4, CHARTWARDEN_UI_LAYOUT_PATTERNS.md).
// Slot-based compositions for the patterns the *built* modules need now but the foundational
// patterns.tsx didn't yet cover: MAR Grid (M13), Scheduling Calendar (M17), Status Board, Admin
// Hierarchy/Settings, Portal Dashboard, Gated Action Flow, Document Viewer. A screen "Use <X>."
// renders the matching layout and fills the slots — layout defined once, here. Bed Board, Media
// Room, Assistant, Portal List ship with their first module screen (later waves).
//
// Lantern (DESIGN.md): tokens only (theme-reactive), No-Line edges (§10) — rails sit on
// surface-lowest with a ghost border; the Portal family is single-column / large-type (§11.11).
import type { JSX, ReactNode } from "react";
import { ghostBorder, t } from "../theme/tokens";

const fillColumn = { display: "flex", flexDirection: "column" as const, minHeight: 0, flex: 1 };
const splitRow = { display: "flex", minHeight: 0, flex: 1, overflow: "hidden" };
const rail = (side: "left" | "right", width: string) => ({
  width,
  flexShrink: 0,
  background: t.surfaceLowest,
  [side === "left" ? "borderRight" : "borderLeft"]: ghostBorder,
  overflowY: "auto" as const,
});

// ────────────────────────────────────────────────────────────────────────────
// MAR Grid — time × medication matrix; cells (not rows) are the unit of work. Composes onto a
// Patient Workspace: sticky banner → window controls → grid | administration/PRN/witness detail.
// ────────────────────────────────────────────────────────────────────────────
export interface MarGridLayoutProps {
  /** Sticky Patient Banner (required on clinical screens). */
  banner: ReactNode;
  /** Shift / day window switch + filters above the grid. */
  windowControls?: ReactNode;
  /** The administration matrix (rows = medications, cols = scheduled times). */
  grid: ReactNode;
  /** Right: Administration / PRN Reassessment / Witness for the selected cell. */
  detail?: ReactNode;
}
export function MarGridLayout({
  banner,
  windowControls,
  grid,
  detail,
}: MarGridLayoutProps): JSX.Element {
  return (
    <div className="wx-mar-grid" style={fillColumn}>
      {banner}
      {windowControls}
      <div style={splitRow}>
        <div
          className="wx-mar-matrix"
          style={{ flex: 1, overflow: "auto", padding: "0.5rem 1rem" }}
        >
          {grid}
        </div>
        {detail}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Scheduling Calendar — resource × time board. header (Day·Week·Map) → roster/proposals | grid |
// detail/conflicts/route. The time axis is the organizing principle (contrast Bed Board).
// ────────────────────────────────────────────────────────────────────────────
export interface SchedulingCalendarLayoutProps {
  header: ReactNode;
  /** Left: Roster + Proposal Inbox. */
  roster?: ReactNode;
  /** Center: the calendar grid (rows = clinicians, cols = time). */
  calendar: ReactNode;
  /** Right: Detail / Conflicts / Route. */
  detail?: ReactNode;
}
export function SchedulingCalendarLayout({
  header,
  roster,
  calendar,
  detail,
}: SchedulingCalendarLayoutProps): JSX.Element {
  return (
    <div className="wx-scheduling-calendar" style={fillColumn}>
      {header}
      <div style={splitRow}>
        {roster ? (
          <nav
            className="wx-sched-roster"
            aria-label="Roster & proposals"
            style={rail("left", "18rem")}
          >
            {roster}
          </nav>
        ) : null}
        <div className="wx-sched-grid" style={{ flex: 1, overflow: "auto" }}>
          {calendar}
        </div>
        {detail}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Status Board — service/health cards + incident timeline + integration status + operational
// controls. Service-state snapshot, not metric-led (that's Dashboard).
// ────────────────────────────────────────────────────────────────────────────
export interface StatusBoardLayoutProps {
  header: ReactNode;
  /** Service Card grid (health per subsystem). */
  services: ReactNode;
  /** Incident Timeline. */
  timeline?: ReactNode;
  /** Integration Status. */
  integrations?: ReactNode;
  /** Operational Controls (e.g. degraded-mode banner / toggles). */
  controls?: ReactNode;
}
export function StatusBoardLayout({
  header,
  services,
  timeline,
  integrations,
  controls,
}: StatusBoardLayoutProps): JSX.Element {
  return (
    <div className="wx-status-board" style={fillColumn}>
      {header}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
          padding: "1.5rem",
        }}
      >
        <div className="wx-status-services">{services}</div>
        {timeline || integrations ? (
          <div
            style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-start" }}
          >
            {timeline ? <div style={{ flex: 2, minWidth: "20rem" }}>{timeline}</div> : null}
            {integrations ? <div style={{ flex: 1, minWidth: "16rem" }}>{integrations}</div> : null}
          </div>
        ) : null}
        {controls}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Admin Hierarchy — manage a tree of entities. header → tree | selected detail | config/validation.
// ────────────────────────────────────────────────────────────────────────────
export interface AdminHierarchyLayoutProps {
  header: ReactNode;
  /** Entity Tree (Org → Provider → Location). */
  tree: ReactNode;
  /** Selected Entity Detail (center). */
  children: ReactNode;
  /** Right: Configuration / Validation. */
  config?: ReactNode;
}
export function AdminHierarchyLayout({
  header,
  tree,
  children,
  config,
}: AdminHierarchyLayoutProps): JSX.Element {
  return (
    <div className="wx-admin-hierarchy" style={fillColumn}>
      {header}
      <div style={splitRow}>
        <nav className="wx-entity-tree" aria-label="Entity tree" style={rail("left", "18rem")}>
          {tree}
        </nav>
        <div className="wx-entity-detail" style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          {children}
        </div>
        {config}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Admin Settings — categorized config with live impact. sidebar | content | help. Optional sticky
// footer for the dirty/unsaved-changes guard + per-section save.
// ────────────────────────────────────────────────────────────────────────────
export interface AdminSettingsLayoutProps {
  header: ReactNode;
  /** Settings Sidebar (categories). */
  sidebar: ReactNode;
  /** Settings Content (center). */
  children: ReactNode;
  /** Right: Help / Impact Notes. */
  help?: ReactNode;
  /** Sticky save bar (dirty-state guard). */
  footer?: ReactNode;
}
export function AdminSettingsLayout({
  header,
  sidebar,
  children,
  help,
  footer,
}: AdminSettingsLayoutProps): JSX.Element {
  return (
    <div className="wx-admin-settings" style={fillColumn}>
      {header}
      <div style={splitRow}>
        <nav
          className="wx-settings-sidebar"
          aria-label="Settings categories"
          style={rail("left", "16rem")}
        >
          {sidebar}
        </nav>
        <div
          className="wx-settings-content"
          style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}
        >
          {children}
        </div>
        {help}
      </div>
      {footer}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Portal Dashboard — patient/family home: a calm single-column stack of cards. Portal family:
// large type, large targets, a persistent after-hours safety affordance (§11.11).
// ────────────────────────────────────────────────────────────────────────────
export interface PortalDashboardLayoutProps {
  /** Portal Header (brand + account). */
  header?: ReactNode;
  /** Patient Summary (greeting / who this is). */
  summary?: ReactNode;
  /** The card stack (Care Team, Next Visit, Messages, Documents, Help). */
  children: ReactNode;
  /** Persistent urgent-care / after-hours safety affordance — sticky at the bottom. */
  safety?: ReactNode;
}
export function PortalDashboardLayout({
  header,
  summary,
  children,
  safety,
}: PortalDashboardLayoutProps): JSX.Element {
  return (
    <div className="wx-portal-dashboard" style={{ ...fillColumn, background: t.background }}>
      {header}
      <div style={{ flex: 1, overflow: "auto", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            width: "100%",
            maxWidth: "44rem",
            display: "flex",
            flexDirection: "column",
            gap: "1.75rem",
            padding: "2rem 1.5rem 3rem",
          }}
        >
          {summary}
          {children}
        </div>
      </div>
      {safety ? (
        <div
          className="wx-portal-safety"
          style={{
            position: "sticky",
            bottom: 0,
            borderTop: ghostBorder,
            background: t.surfaceLowest,
            padding: "0.75rem 1.5rem",
          }}
        >
          {safety}
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Gated Action Flow — linear, approval-gated, fully-audited flow where access is the product:
// Subject → Reason/Scope → Approval → Active Session (persistent banner) → Audit Log.
// ────────────────────────────────────────────────────────────────────────────
export interface GatedActionFlowLayoutProps {
  /** Persistent session banner once access is active (e.g. BreakGlassBanner). Pinned to top. */
  sessionBanner?: ReactNode;
  header: ReactNode;
  /** Stage indicator (Subject → Reason → Approval → Session → Audit). */
  stages?: ReactNode;
  /** The active stage's content (center). */
  children: ReactNode;
  /** Right: the running audit log of the flow. */
  auditLog?: ReactNode;
}
export function GatedActionFlowLayout({
  sessionBanner,
  header,
  stages,
  children,
  auditLog,
}: GatedActionFlowLayoutProps): JSX.Element {
  return (
    <div className="wx-gated-action-flow" style={fillColumn}>
      {sessionBanner}
      {header}
      {stages}
      <div style={splitRow}>
        <div className="wx-gated-stage" style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          {children}
        </div>
        {auditLog ? (
          <aside className="wx-gated-audit" aria-label="Audit log" style={rail("right", "22rem")}>
            <div style={{ padding: "1rem" }}>{auditLog}</div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Document Viewer — portal-facing sibling of the Review Workspace. list | viewer | action panel
// (View / Sign / Acknowledge). Portal family.
// ────────────────────────────────────────────────────────────────────────────
export interface DocumentViewerLayoutProps {
  header?: ReactNode;
  /** Document List (left). */
  list: ReactNode;
  /** The document preview/viewer (center). */
  viewer: ReactNode;
  /** Action Panel — View / Sign / Acknowledge (right). */
  actions?: ReactNode;
}
export function DocumentViewerLayout({
  header,
  list,
  viewer,
  actions,
}: DocumentViewerLayoutProps): JSX.Element {
  return (
    <div className="wx-document-viewer" style={fillColumn}>
      {header}
      <div style={splitRow}>
        <nav className="wx-doc-list" aria-label="Documents" style={rail("left", "18rem")}>
          {list}
        </nav>
        <div
          className="wx-doc-viewer"
          style={{ flex: 1, overflow: "auto", background: t.surfaceLow }}
        >
          {viewer}
        </div>
        {actions ? (
          <aside
            className="wx-doc-actions"
            aria-label="Document actions"
            style={rail("right", "18rem")}
          >
            <div style={{ padding: "1rem" }}>{actions}</div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
