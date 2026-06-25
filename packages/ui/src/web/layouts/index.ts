// @wardenx/ui — layout kit (F0-T04, ADR-0030). Tier-1 regions + foundational Tier-2 pattern
// layouts from WARDENX_UI_LAYOUT_PATTERNS.md. Screens compose these instead of reinventing layout.
export {
  FilterBar,
  KpiCard,
  KpiStrip,
  LeftNavRail,
  PageHeader,
  PatientBanner,
  RightDetailPanel,
  StickyFooterActions,
} from "./regions";
export type {
  KpiCardProps,
  PageHeaderProps,
  PatientBannerProps,
  RightDetailPanelProps,
} from "./regions";
export {
  AdminSplitLayout,
  CenteredCardLayout,
  CenteredStatusLayout,
  ConversationView,
  DashboardLayout,
  DetailPageLayout,
  PatientWorkspaceLayout,
  StepperWorkflowLayout,
  WorkQueueLayout,
} from "./patterns";
export type {
  AdminSplitLayoutProps,
  CenteredCardLayoutProps,
  CenteredStatusLayoutProps,
  ConversationViewProps,
  DashboardLayoutProps,
  DetailPageLayoutProps,
  PatientWorkspaceLayoutProps,
  StepperWorkflowLayoutProps,
  WorkQueueLayoutProps,
} from "./patterns";
// Domain Tier-2 patterns (R0.4) — for the built modules that need them now.
export {
  AdminHierarchyLayout,
  AdminSettingsLayout,
  DocumentViewerLayout,
  GatedActionFlowLayout,
  MarGridLayout,
  PortalDashboardLayout,
  SchedulingCalendarLayout,
  StatusBoardLayout,
} from "./domain-patterns";
export type {
  AdminHierarchyLayoutProps,
  AdminSettingsLayoutProps,
  DocumentViewerLayoutProps,
  GatedActionFlowLayoutProps,
  MarGridLayoutProps,
  PortalDashboardLayoutProps,
  SchedulingCalendarLayoutProps,
  StatusBoardLayoutProps,
} from "./domain-patterns";
