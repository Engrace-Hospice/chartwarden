// @wardenx/ui — foundational Tier-2 pattern layouts (F0-T04, ADR-0030).
// Slot-based compositions of the Tier-1 regions (regions.tsx), one per foundational pattern in
// WARDENX_UI_LAYOUT_PATTERNS.md with a near-term consumer. A screen "Use <Pattern>." renders the
// matching layout and fills the slots. Domain/surface-specific patterns (MAR Grid, Bed Board,
// Scheduling Calendar, Admin/Portal variants, Assistant, …) ship with their first module screen.
//
// Lantern (DESIGN.md): tokens only (theme-reactive), No-Line edges (§10), type voices (§3) — see
// regions.tsx for the rationale; these layouts inherit the same discipline.
import type { JSX, ReactNode } from "react";
import { cardSurface, ghostBorder, t } from "../theme/tokens";

const fillColumn = { display: "flex", flexDirection: "column" as const, minHeight: 0, flex: 1 };
const splitRow = { display: "flex", minHeight: 0, flex: 1, overflow: "hidden" };
// A right-hand context rail. Sized like the `18rem` rails ConversationView/AdminSplitLayout use, but
// with `flexShrink: 0` doing the real work: an aside is an unsized flex sibling otherwise, so long
// prose inside it (M15's §5.1 volunteer-ratio bands/numerator explainers) grows the rail until the
// `flex: 1` workspace beside it collapses to a sliver. The trailing padding is the right gutter the
// centre column already has — without it the rail runs flush to the viewport edge.
const asideRail = {
  width: "18rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1rem 1.5rem 1rem 0",
};
// The same starvation bug in the OTHER optional side regions (WorkQueue `detail`, DetailPage `aside`,
// ConversationView `detail`) — but those cannot take `asideRail`'s fixed width, because their callers
// usually pass an ALREADY-sized child: `RightDetailPanel` is 24rem/flexShrink-0, and M23's
// sequestration-policy + eligibility-center asides are 22rem. A fixed outer rail would fight those.
// So this only puts a ceiling on the unsized case: a self-sizing child up to 24rem is untouched,
// while a bare <div> of prose is capped instead of growing until the workspace collapses.
// The `wx-context-rail` class carries the GUTTER (index.css). It cannot live here, because whether the
// rail should be padded depends on what the caller passed: `RightDetailPanel` is a full-bleed panel that
// supplies its own padding and a `borderLeft` meant to meet the shell edge, whereas ~12 screens pass a
// bare <div>/<span>, which then sits flush against the viewport with no chrome at all. A `:has()` rule
// pads only the second case; an inline style could not tell them apart.
const contextRailBounds = { flexShrink: 0, minWidth: 0, maxWidth: "24rem", overflow: "auto" };

/** Auth Flow — a single focused action on a centered card (sign-in, MFA, org-select, step-up). */
export interface CenteredCardLayoutProps {
  brand?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}
export function CenteredCardLayout({
  brand,
  children,
  footer,
}: CenteredCardLayoutProps): JSX.Element {
  return (
    <div
      className="wx-auth-flow"
      style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "1.5rem" }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "24rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {brand ? (
          <div className="wx-auth-brand" style={{ textAlign: "center" }}>
            {brand}
          </div>
        ) : null}
        <div className="wx-auth-card" style={{ ...cardSurface, padding: "1.5rem" }}>
          {children}
        </div>
        {footer ? (
          <div className="wx-auth-footer" style={{ textAlign: "center", fontSize: "0.85rem" }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** System Page — centered status (error/offline/maintenance/no-access). No PHI, no stack traces. */
export interface CenteredStatusLayoutProps {
  icon?: ReactNode;
  headline: ReactNode;
  explanation?: ReactNode;
  actions?: ReactNode;
  correlationId?: string;
}
export function CenteredStatusLayout({
  icon,
  headline,
  explanation,
  actions,
  correlationId,
}: CenteredStatusLayoutProps): JSX.Element {
  return (
    <div
      className="wx-system-page"
      // biome-ignore lint/a11y/useSemanticElements: role="status" is an ARIA live region with no single semantic-element equivalent.
      role="status"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "1.5rem",
        textAlign: "center",
      }}
    >
      <div
        style={{
          maxWidth: "28rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          alignItems: "center",
        }}
      >
        {icon ? (
          // Circular tonal badge holding the status glyph (System Page frame, dT1Bt). The icon
          // inherits `currentColor`, so a <Glyph> renders in the muted on-surface-variant tone.
          <div
            className="wx-system-icon"
            style={{
              width: "3.5rem",
              height: "3.5rem",
              borderRadius: "9999px",
              background: t.surfaceContainer,
              color: t.onSurfaceVariant,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.5rem",
            }}
          >
            {icon}
          </div>
        ) : null}
        <h1
          style={{
            margin: 0,
            fontFamily: t.fontDisplay,
            fontSize: "1.75rem",
            fontWeight: 500,
            color: t.onSurface,
          }}
        >
          {headline}
        </h1>
        {explanation ? <p style={{ margin: 0, color: t.onSurfaceVariant }}>{explanation}</p> : null}
        {actions ? (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>{actions}</div>
        ) : null}
        {/* Correlation id is a code → mono, muted (§3.1). */}
        {correlationId ? (
          <code style={{ fontFamily: t.fontMono, fontSize: "0.75rem", color: t.muted }}>
            {correlationId}
          </code>
        ) : null}
      </div>
    </div>
  );
}

/** Work Queue — header (+ optional KPI/filter) over a Work Table | Right Detail Panel split. */
export interface WorkQueueLayoutProps {
  header: ReactNode;
  kpis?: ReactNode;
  filters?: ReactNode;
  table: ReactNode;
  detail?: ReactNode;
  /** Let the application shell scroll the complete queue instead of only its table area. */
  fullPageScroll?: boolean;
}
export function WorkQueueLayout({
  header,
  kpis,
  filters,
  table,
  detail,
  fullPageScroll = false,
}: WorkQueueLayoutProps): JSX.Element {
  return (
    <div className="wx-work-queue" style={fillColumn}>
      {header}
      {kpis}
      {filters}
      {/* `wx-work-split` marks the region that must NOT be padded by the bare-slot rule in index.css:
          the table and the context rail each own their inset. */}
      <div
        className="wx-work-split"
        style={fullPageScroll ? { display: "flex", minHeight: 0, flexShrink: 0 } : splitRow}
      >
        <div
          className="wx-work-table"
          style={
            fullPageScroll
              ? { flex: 1, minWidth: 0, overflowX: "auto" }
              : { flex: 1, overflow: "auto" }
          }
        >
          {table}
        </div>
        {detail ? (
          <div className="wx-context-rail" style={contextRailBounds}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Dashboard — KPI strip + charts + contributing-records table, with an optional right aside. */
export interface DashboardLayoutProps {
  header: ReactNode;
  kpis?: ReactNode;
  charts?: ReactNode;
  table?: ReactNode;
  aside?: ReactNode;
}
export function DashboardLayout({
  header,
  kpis,
  charts,
  table,
  aside,
}: DashboardLayoutProps): JSX.Element {
  return (
    <div className="wx-dashboard" style={fillColumn}>
      {header}
      {kpis}
      <div className="wx-stepper-split" style={splitRow}>
        <div
          style={{
            flex: 1,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            padding: "1rem 1.5rem",
          }}
        >
          {charts}
          {table}
        </div>
        {aside ? (
          <div className="wx-dashboard-aside" style={asideRail}>
            {aside}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Stepper Workflow — Left step rail | Center workspace | optional right context + sticky footer. */
export interface StepperWorkflowLayoutProps {
  header: ReactNode;
  steps: ReactNode;
  children: ReactNode;
  context?: ReactNode;
  footer?: ReactNode;
}
export function StepperWorkflowLayout({
  header,
  steps,
  children,
  context,
  footer,
}: StepperWorkflowLayoutProps): JSX.Element {
  return (
    <div className="wx-stepper" style={fillColumn}>
      {header}
      <div style={splitRow}>
        {steps}
        <div
          className="wx-center-workspace"
          style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}
        >
          {children}
        </div>
        {context}
      </div>
      {footer}
    </div>
  );
}

/** Patient Workspace — sticky Patient Banner over a context header + patient-scoped content. */
export interface PatientWorkspaceLayoutProps {
  banner: ReactNode;
  contextHeader?: ReactNode;
  children: ReactNode;
}
export function PatientWorkspaceLayout({
  banner,
  contextHeader,
  children,
}: PatientWorkspaceLayoutProps): JSX.Element {
  return (
    <div className="wx-patient-workspace" style={fillColumn}>
      {banner}
      {contextHeader}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
    </div>
  );
}

/** Conversation View — a conversation List | the active Message Thread (+ composer) | right detail. */
export interface ConversationViewProps {
  list: ReactNode;
  children: ReactNode;
  detail?: ReactNode;
}
export function ConversationView({ list, children, detail }: ConversationViewProps): JSX.Element {
  return (
    <div className="wx-conversation" style={fillColumn}>
      <div style={splitRow}>
        <div
          className="wx-conversation-list"
          style={{
            width: "18rem",
            flexShrink: 0,
            borderRight: ghostBorder,
            overflow: "auto",
          }}
        >
          {list}
        </div>
        <div
          className="wx-conversation-thread"
          style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          {children}
        </div>
        {detail ? (
          <div className="wx-context-rail" style={contextRailBounds}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Admin Split Layout — a selectable subject List | a Matrix (subject × capability) | right detail. */
export interface AdminSplitLayoutProps {
  header: ReactNode;
  list: ReactNode;
  children: ReactNode;
  detail?: ReactNode;
  /** Optional screen hook for responsive/sticky variations of this shared composition. */
  className?: string;
  /** Let the application shell scroll the entire administration workspace, rather than trapping
   * vertical scrolling inside its three columns. */
  fullPageScroll?: boolean;
}
export function AdminSplitLayout({
  header,
  list,
  children,
  detail,
  className,
  fullPageScroll = false,
}: AdminSplitLayoutProps): JSX.Element {
  return (
    <div
      className={`wx-admin-split${className ? ` ${className}` : ""}`}
      style={fullPageScroll ? { display: "flex", flexDirection: "column" } : fillColumn}
    >
      {header}
      <div
        className="wx-admin-split-workspace"
        style={fullPageScroll ? { display: "flex", minHeight: 0, flexShrink: 0 } : splitRow}
      >
        <div
          className="wx-admin-list wx-no-scrollbar"
          style={{
            width: "18rem",
            flexShrink: 0,
            borderRight: ghostBorder,
            overflow: fullPageScroll ? "visible" : "auto",
          }}
        >
          {list}
        </div>
        <div
          className="wx-admin-matrix wx-no-scrollbar"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: fullPageScroll ? "visible" : "auto",
            padding: "1.5rem",
          }}
        >
          {children}
        </div>
        {detail ? (
          <div className="wx-context-rail wx-no-scrollbar" style={contextRailBounds}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Detail Page — a context header over a primary reading/editing surface + optional right aside. */
export interface DetailPageLayoutProps {
  header: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}
export function DetailPageLayout({ header, children, aside }: DetailPageLayoutProps): JSX.Element {
  return (
    <div className="wx-detail-page" style={fillColumn}>
      {header}
      <div style={splitRow}>
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>{children}</div>
        {aside ? (
          <div className="wx-context-rail" style={contextRailBounds}>
            {aside}
          </div>
        ) : null}
      </div>
    </div>
  );
}
