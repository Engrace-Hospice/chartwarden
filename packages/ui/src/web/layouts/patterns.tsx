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
          <div className="wx-system-icon" style={{ fontSize: "2rem" }}>
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
}
export function WorkQueueLayout({
  header,
  kpis,
  filters,
  table,
  detail,
}: WorkQueueLayoutProps): JSX.Element {
  return (
    <div className="wx-work-queue" style={fillColumn}>
      {header}
      {kpis}
      {filters}
      <div style={splitRow}>
        <div className="wx-work-table" style={{ flex: 1, overflow: "auto" }}>
          {table}
        </div>
        {detail}
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
      <div style={splitRow}>
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
        {aside}
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
        {detail}
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
}
export function AdminSplitLayout({
  header,
  list,
  children,
  detail,
}: AdminSplitLayoutProps): JSX.Element {
  return (
    <div className="wx-admin-split" style={fillColumn}>
      {header}
      <div style={splitRow}>
        <div
          className="wx-admin-list"
          style={{
            width: "18rem",
            flexShrink: 0,
            borderRight: ghostBorder,
            overflow: "auto",
          }}
        >
          {list}
        </div>
        <div className="wx-admin-matrix" style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          {children}
        </div>
        {detail}
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
        {aside}
      </div>
    </div>
  );
}
