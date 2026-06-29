import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/27-cost-report — M27 Cost Report screen registration (R2, ADR-0030, §5). The read
// surface over the live /api/v1/cost-reports/* + /api/v1/cost-report-validation-rules backend. Each
// `requiredPermission` is the REAL §4.6 M27 key the matching route gates on (mirrored into
// packages/auth/src/permissions/contributed.ts) — the server stays the authoritative enforcer; this gates
// nav visibility only. All six surfaces sit under "Billing" (the revenue cycle). Aligned to the realigned
// Form CMS-1984-14 worksheet model (A → B/B-1 → C per-diem; no D/E-1/G/H).
import type { ComponentType } from "react";
import { CostReportBadDebt } from "./cost-report-bad-debt";
import { CostReportList } from "./cost-report-list";
import { CostReportRules } from "./cost-report-rules";
import { CostReportSnapshots } from "./cost-report-snapshots";
import { CostReportValidation } from "./cost-report-validation";
import { CostReportWorkspace } from "./cost-report-workspace";

export const costReportScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 27,
  slug: "27-cost-report",
  screens: [
    {
      id: "cost_report.list",
      path: "/cost-reports",
      title: "Cost Reports",
      navGroup: "Billing",
      requiredPermission: "cost_report.read",
      screen: CostReportList,
    },
    {
      id: "cost_report.workspace",
      path: "/cost-reports/workspace",
      title: "Cost Report Workspace",
      navGroup: "Billing",
      requiredPermission: "cost_report.read",
      screen: CostReportWorkspace,
    },
    {
      id: "cost_report.validation",
      path: "/cost-reports/validation",
      title: "Validation Worklist",
      navGroup: "Billing",
      requiredPermission: "cost_report.read",
      screen: CostReportValidation,
    },
    {
      id: "cost_report.rules",
      path: "/cost-reports/rules",
      title: "Validation Rules",
      navGroup: "Billing",
      requiredPermission: "cost_report.read_rules",
      screen: CostReportRules,
    },
    {
      id: "cost_report.bad_debt",
      path: "/cost-reports/bad-debt",
      title: "Bad-Debt Log",
      navGroup: "Billing",
      requiredPermission: "cost_report.read",
      screen: CostReportBadDebt,
    },
    {
      id: "cost_report.snapshots",
      path: "/cost-reports/snapshots",
      title: "Snapshots & ECR",
      navGroup: "Billing",
      requiredPermission: "cost_report.read_snapshot_detail",
      screen: CostReportSnapshots,
    },
  ],
};
