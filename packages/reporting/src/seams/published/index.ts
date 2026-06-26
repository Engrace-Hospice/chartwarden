// @wardenx/reporting — published-seam barrel (M33 §4.3).
//
// The three seams M33 PUBLISHES for embedded surfaces (M30/M34/M37): the metric read surface, the
// dashboard catalog, and the scheduled-report read + revocation-cascade surface. Registered into the
// M1 SeamRegistry at boot (P2C) via `registerReportingPublishedSeams` (see ../../seam-registration).
export type { MetricsProvider } from "./metrics-provider";
export type { DashboardCatalogProvider } from "./dashboard-catalog-provider";
export type { ScheduledReportProvider } from "./scheduled-report-provider";

// The live (port-injected) implementations the composition root binds into the M1 SeamRegistry at boot (P2C).
export {
  type CascadeScheduleRow,
  type CascadeSchedulePatch,
  type DashboardCatalogProviderDeps,
  type DashboardMetricExecutorPort,
  type MetricsProviderDeps,
  type RecipientCascadeDecision,
  type ReportingPublishedSeamDeps,
  type ScheduleCascadeStore,
  type ScheduledReportProviderDeps,
  DashboardCatalogProviderImpl,
  MetricsProviderImpl,
  ScheduledReportProviderImpl,
  decideRecipientCascade,
} from "./providers";
