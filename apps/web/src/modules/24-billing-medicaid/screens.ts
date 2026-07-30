import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/24-billing-medicaid — M24 Billing — Medicaid screen registration (R2, ADR-0030,
// §5.1). The read + write surface over the live /api/v1/medicaid-* + /api/v1/rb-* backend (38 routes). Each
// `requiredPermission` is the REAL §4.7 M24 key the matching route gates on
// (apps/backend/src/modules/24-billing-medicaid/permission-keys.ts, mirrored into
// packages/auth/src/permissions/contributed.ts) — the server stays the authoritative enforcer; this gates
// nav visibility only. The tenant surfaces sit under "Billing" (revenue cycle); the engagement-scoped
// surveyor read view sits under "Admin", matching the M23 /admin/billing-audit precedent.
//
// §5.1 modals and panels are NOT separate registry entries — the override modal, submit/replace-void
// ceremony, and R&B day override live inside their parent screens; the submissions and acknowledgments
// panels are sub-routes of the claim so a biller can link straight to a timeline.
import type { ComponentType } from "react";
import { MedicaidAcknowledgmentsTimeline } from "./acknowledgments-timeline";
import { MedicaidArDashboard } from "./ar-dashboard";
import { MedicaidAssemblyWizard } from "./claim-assembly-wizard";
import { MedicaidClaimEditor } from "./claim-editor";
import { MedicaidClaimWorkbench } from "./claim-workbench";
import { MedicaidEligibilityCenter } from "./eligibility-center";
import { MedicaidMetricsSurface } from "./metrics-surface";
import { MedicaidOverrideAudit } from "./override-audit";
import { MedicaidRbArrangementDetail } from "./rb-arrangement-detail";
import { MedicaidRbArrangements } from "./rb-arrangements";
import { MedicaidRuleConfig } from "./rule-config";
import { MedicaidSubmissionsTimeline } from "./submissions-timeline";
import { MedicaidSurveyorReadView } from "./surveyor-read-view";
import { MedicaidTradingPartnerCredentials } from "./trading-partner-credentials";
import { MedicaidValidationQueue } from "./validation-queue";
import { MedicaidValidationWorklist } from "./validation-worklist";

export const medicaidBillingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 24,
  slug: "24-billing-medicaid",
  screens: [
    // --- AR landing (§5.1 #1) ---
    {
      id: "medicaid.ar-dashboard",
      path: "/medicaid/billing/ar-dashboard",
      title: "Medicaid AR",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.read_ar_dashboard",
      screen: MedicaidArDashboard,
    },
    // --- claim lifecycle (§5.1 #2, #3, #4, #8, #9) ---
    {
      id: "medicaid.claims",
      path: "/medicaid/billing/claims",
      title: "Medicaid Claims",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.read",
      screen: MedicaidClaimWorkbench,
    },
    {
      id: "medicaid.claim.new",
      path: "/medicaid/billing/claims/new",
      title: "Assemble Medicaid Claim",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.assemble",
      screen: MedicaidAssemblyWizard,
    },
    {
      id: "medicaid.claim",
      path: "/medicaid/billing/claims/:claimId",
      title: "Medicaid Claim",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.read",
      screen: MedicaidClaimEditor,
    },
    {
      id: "medicaid.claim.validation",
      path: "/medicaid/billing/claims/:claimId/validation",
      title: "Claim Validation",
      navGroup: "Billing",
      requiredPermission: "medicaid.validation.read_run",
      screen: MedicaidValidationWorklist,
    },
    {
      id: "medicaid.claim.submissions",
      path: "/medicaid/billing/claims/:claimId/submissions",
      title: "Claim Submissions",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.read",
      screen: MedicaidSubmissionsTimeline,
    },
    {
      id: "medicaid.claim.acknowledgments",
      path: "/medicaid/billing/claims/:claimId/acknowledgments",
      title: "Claim Acknowledgments",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.read",
      screen: MedicaidAcknowledgmentsTimeline,
    },
    // --- org-wide validation worklist (§5.1 #5) ---
    {
      id: "medicaid.validation-worklist",
      path: "/medicaid/billing/validation-worklist",
      title: "Validation Worklist",
      navGroup: "Billing",
      requiredPermission: "medicaid.validation.read_run",
      screen: MedicaidValidationQueue,
    },
    // --- Room & Board (§5.1 #11, #12, #13) ---
    {
      id: "medicaid.rb-arrangements",
      path: "/medicaid/billing/rb-arrangements",
      title: "R&B Arrangements",
      navGroup: "Billing",
      requiredPermission: "medicaid.rb_arrangement.read",
      screen: MedicaidRbArrangements,
    },
    {
      id: "medicaid.rb-arrangement",
      path: "/medicaid/billing/rb-arrangements/:arrangementId",
      title: "R&B Arrangement",
      navGroup: "Billing",
      requiredPermission: "medicaid.rb_arrangement.read",
      screen: MedicaidRbArrangementDetail,
    },
    // --- compliance + admin (§5.1 #14, #15, #16, #17, #18) ---
    {
      id: "medicaid.rule-config",
      path: "/medicaid/billing/rule-config",
      title: "Medicaid Rules",
      navGroup: "Billing",
      requiredPermission: "medicaid.rule_config.read",
      screen: MedicaidRuleConfig,
    },
    {
      id: "medicaid.eligibility",
      path: "/medicaid/billing/eligibility",
      title: "Medicaid Eligibility",
      navGroup: "Billing",
      requiredPermission: "medicaid.eligibility.read",
      screen: MedicaidEligibilityCenter,
    },
    {
      id: "medicaid.trading-partners",
      path: "/medicaid/billing/trading-partner-credentials",
      title: "Trading Partners",
      navGroup: "Billing",
      requiredPermission: "medicaid.trading_partner.read",
      screen: MedicaidTradingPartnerCredentials,
    },
    {
      id: "medicaid.overrides",
      path: "/medicaid/billing/override-audit",
      title: "Medicaid Overrides",
      navGroup: "Billing",
      requiredPermission: "medicaid.validation.read_override",
      screen: MedicaidOverrideAudit,
    },
    {
      id: "medicaid.metrics",
      path: "/medicaid/billing/metrics",
      title: "Medicaid Metrics",
      navGroup: "Billing",
      requiredPermission: "medicaid.claim.read_metrics",
      screen: MedicaidMetricsSurface,
    },
    // --- engagement-scoped surveyor read (§5.1 #19) ---
    {
      id: "medicaid.surveyor-read",
      path: "/admin/medicaid-billing-audit/:claimId",
      title: "Medicaid Claim (survey)",
      navGroup: "Admin",
      requiredPermission: "medicaid.claim.read",
      screen: MedicaidSurveyorReadView,
    },
  ],
};
