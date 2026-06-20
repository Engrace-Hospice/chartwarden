// @wardenx/ui — foundational Tier-2 pattern layouts (F0-T04, ADR-0030).
// Slot-based compositions of the Tier-1 regions (regions.tsx), one per foundational pattern in
// WARDENX_UI_LAYOUT_PATTERNS.md with a near-term consumer. A screen "Use <Pattern>." renders the
// matching layout and fills the slots. Domain/surface-specific patterns (MAR Grid, Bed Board,
// Scheduling Calendar, Admin/Portal variants, Assistant, …) ship with their first module screen.
import type { JSX, ReactNode } from "react";

const fillColumn = { display: "flex", flexDirection: "column" as const, minHeight: 0, flex: 1 };
const splitRow = { display: "flex", minHeight: 0, flex: 1, overflow: "hidden" };

/** Auth Flow — a single focused action on a centered card (sign-in, MFA, org-select, step-up). */
export interface CenteredCardLayoutProps {
  brand?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}
export function CenteredCardLayout({ brand, children, footer }: CenteredCardLayoutProps): JSX.Element {
  return (
    <div className="wx-auth-flow" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "1.5rem" }}>
      <div style={{ width: "100%", maxWidth: "24rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        {brand ? <div className="wx-auth-brand" style={{ textAlign: "center" }}>{brand}</div> : null}
        <div className="wx-auth-card" style={{ border: "1px solid #e5e7eb", borderRadius: "0.75rem", padding: "1.5rem", background: "#fff" }}>
          {children}
        </div>
        {footer ? <div className="wx-auth-footer" style={{ textAlign: "center", fontSize: "0.85rem" }}>{footer}</div> : null}
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
export function CenteredStatusLayout({ icon, headline, explanation, actions, correlationId }: CenteredStatusLayoutProps): JSX.Element {
  return (
    <div className="wx-system-page" role="status" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "1.5rem", textAlign: "center" }}>
      <div style={{ maxWidth: "28rem", display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "center" }}>
        {icon ? <div className="wx-system-icon" style={{ fontSize: "2rem" }}>{icon}</div> : null}
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>{headline}</h1>
        {explanation ? <p style={{ margin: 0, color: "#6b7280" }}>{explanation}</p> : null}
        {actions ? <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>{actions}</div> : null}
        {correlationId ? <code style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{correlationId}</code> : null}
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
export function WorkQueueLayout({ header, kpis, filters, table, detail }: WorkQueueLayoutProps): JSX.Element {
  return (
    <div className="wx-work-queue" style={fillColumn}>
      {header}
      {kpis}
      {filters}
      <div style={splitRow}>
        <div className="wx-work-table" style={{ flex: 1, overflow: "auto" }}>{table}</div>
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
export function DashboardLayout({ header, kpis, charts, table, aside }: DashboardLayoutProps): JSX.Element {
  return (
    <div className="wx-dashboard" style={fillColumn}>
      {header}
      {kpis}
      <div style={splitRow}>
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem 1.5rem" }}>
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
export function StepperWorkflowLayout({ header, steps, children, context, footer }: StepperWorkflowLayoutProps): JSX.Element {
  return (
    <div className="wx-stepper" style={fillColumn}>
      {header}
      <div style={splitRow}>
        {steps}
        <div className="wx-center-workspace" style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>{children}</div>
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
export function PatientWorkspaceLayout({ banner, contextHeader, children }: PatientWorkspaceLayoutProps): JSX.Element {
  return (
    <div className="wx-patient-workspace" style={fillColumn}>
      {banner}
      {contextHeader}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{children}</div>
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
