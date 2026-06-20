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
  CenteredCardLayout,
  CenteredStatusLayout,
  DashboardLayout,
  DetailPageLayout,
  PatientWorkspaceLayout,
  StepperWorkflowLayout,
  WorkQueueLayout,
} from "./patterns";
export type {
  CenteredCardLayoutProps,
  CenteredStatusLayoutProps,
  DashboardLayoutProps,
  DetailPageLayoutProps,
  PatientWorkspaceLayoutProps,
  StepperWorkflowLayoutProps,
  WorkQueueLayoutProps,
} from "./patterns";
