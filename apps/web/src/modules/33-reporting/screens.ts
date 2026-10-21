import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/33-reporting — M33 Reporting & Analytics screen registration (R2, ADR-0030).
// The read surface (§5.1 screen inventory). Each `requiredPermission` is the REAL §4.6 M33 key the
// matching list/read route gates on (apps/backend/src/modules/33-reporting/permission-keys.ts) — the
// server stays the authoritative enforcer; this only gates nav visibility. Reporting screens sit under
// the "Reports" navGroup; the platform/compliance MV-admin console under "Platform".
import { lazy } from "react";
import type { ComponentType } from "react";
const DashboardRender = lazy(() =>
  import("./dashboard-render").then((m) => ({ default: m.DashboardRender })),
);
const ReportingAdmin = lazy(() =>
  import("./reporting-admin").then((m) => ({ default: m.ReportingAdmin })),
);
const ReportingCatalog = lazy(() =>
  import("./reporting-catalog").then((m) => ({ default: m.ReportingCatalog })),
);
const ReportingSchedules = lazy(() =>
  import("./reporting-schedules").then((m) => ({ default: m.ReportingSchedules })),
);
const RoleDashboard = lazy(() =>
  import("./role-dashboard").then((m) => ({ default: m.RoleDashboard })),
);

export const reportingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 33,
  slug: "33-reporting",
  screens: [
    // --- reporting read surface (§5.1) ---
    {
      id: "reporting.catalog",
      path: "/reports",
      title: "Reports",
      navGroup: "Reports",
      requiredPermission: "report.dashboard.list",
      screen: ReportingCatalog,
    },
    {
      id: "reporting.dashboard",
      path: "/reports/dashboards/:dashboardId",
      title: "Dashboard",
      navGroup: "Reports",
      requiredPermission: "report.dashboard.read",
      screen: DashboardRender,
    },
    {
      id: "reporting.role-dashboard",
      path: "/reports/role/:roleKey",
      title: "Role Dashboard",
      navGroup: "Reports",
      requiredPermission: "report.dashboard.read",
      screen: RoleDashboard,
    },
    {
      id: "reporting.schedules",
      path: "/reports/schedules",
      title: "Scheduled Reports",
      navGroup: "Reports",
      requiredPermission: "report.schedule.list",
      screen: ReportingSchedules,
    },
    // --- platform / compliance admin console (§5.1.7, reporting_admin) ---
    {
      id: "reporting.admin",
      path: "/reports/admin",
      title: "Reporting Admin",
      navGroup: "Platform",
      requiredPermission: "report.admin.mv_list",
      screen: ReportingAdmin,
    },
  ],
};
