import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare screen registration (R2, ADR-0030,
// §5.1 / §10 PR-J). The read + write surface over the existing /api/v1/billing/* backend (37 routes). Each
// `requiredPermission` is the REAL §4.6 M23 key the matching route gates on
// (apps/backend/src/modules/23-billing-medicare/permission-keys.ts, mirrored into
// packages/auth/src/permissions/contributed.ts) — the server stays the authoritative enforcer; this only
// gates nav visibility. Billing screens sit under the "Billing" navGroup; the surveyor read view (#21,
// /admin/billing-audit) sits under "Admin".
import type { ComponentType } from "react";
import { AcknowledgmentsTimeline } from "./acknowledgments-timeline";
import { ArDashboard } from "./ar-dashboard";
import { ClaimAssemblyWizard } from "./claim-assembly-wizard";
import { ClaimEditor } from "./claim-editor";
import { ClaimWorkbench } from "./claim-workbench";
import { EligibilityCenter } from "./eligibility-center";
import { MacCredentials } from "./mac-credentials";
import { MetricsSurface } from "./metrics-surface";
import { NoeDetail } from "./noe-detail";
import { NoeQueue } from "./noe-queue";
import { NotrDetail } from "./notr-detail";
import { NotrQueue } from "./notr-queue";
import { OverrideAudit } from "./override-audit";
import { RuleConfigEditor } from "./rule-config";
import { SequestrationPolicy } from "./sequestration-policy";
import { SubmissionsTimeline } from "./submissions-timeline";
import { SurveyorReadView } from "./surveyor-read-view";
import { ValidationWorklist } from "./validation-worklist";

export const billingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 23,
  slug: "23-billing-medicare",
  screens: [
    // --- AR dashboard landing (§5.1 #1) ---
    {
      id: "billing.ar-dashboard",
      path: "/billing",
      title: "Accounts Receivable",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read_ar_dashboard",
      screen: ArDashboard,
    },
    // --- claim workbench (Work Queue) (§5.1 #2) ---
    {
      id: "billing.claims",
      path: "/billing/claims",
      title: "Claim Workbench",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read",
      screen: ClaimWorkbench,
    },
    // --- claim assembly wizard (§5.1 #3) ---
    {
      id: "billing.claim.new",
      path: "/billing/claims/new",
      title: "Assemble Claim",
      navGroup: "Billing",
      requiredPermission: "billing.claim.assemble",
      screen: ClaimAssemblyWizard,
    },
    // --- claim editor / detail (§5.1 #4) ---
    {
      id: "billing.claim",
      path: "/billing/claims/:claimId",
      title: "Claim Editor",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read",
      screen: ClaimEditor,
    },
    // --- claim validation worklist (§5.1 #5) ---
    {
      id: "billing.claim.validation",
      path: "/billing/claims/:claimId/validation",
      title: "Validation Worklist",
      navGroup: "Billing",
      requiredPermission: "billing.validation.read_run",
      screen: ValidationWorklist,
    },
    // --- claim submissions timeline (§5.1 #6) ---
    {
      id: "billing.claim.submissions",
      path: "/billing/claims/:claimId/submissions",
      title: "Submissions",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read",
      screen: SubmissionsTimeline,
    },
    // --- claim acknowledgments timeline (§5.1 #7) ---
    {
      id: "billing.claim.acknowledgments",
      path: "/billing/claims/:claimId/acknowledgments",
      title: "Acknowledgments",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read",
      screen: AcknowledgmentsTimeline,
    },
    // --- NOE queue + detail (§5.1 #8/#9) ---
    {
      id: "billing.noe",
      path: "/billing/noe",
      title: "NOE Queue",
      navGroup: "Billing",
      requiredPermission: "billing.noe.read",
      screen: NoeQueue,
    },
    {
      id: "billing.noe.detail",
      path: "/billing/noe/:noeId",
      title: "NOE Detail",
      navGroup: "Billing",
      requiredPermission: "billing.noe.read",
      screen: NoeDetail,
    },
    // --- NOTR queue + detail (§5.1 #10/#11) ---
    {
      id: "billing.notr",
      path: "/billing/notr",
      title: "NOTR Queue",
      navGroup: "Billing",
      requiredPermission: "billing.notr.read",
      screen: NotrQueue,
    },
    {
      id: "billing.notr.detail",
      path: "/billing/notr/:notrId",
      title: "NOTR Detail",
      navGroup: "Billing",
      requiredPermission: "billing.notr.read",
      screen: NotrDetail,
    },
    // --- validation rule config (§5.1 #12) ---
    {
      id: "billing.rule-config",
      path: "/billing/rule-config",
      title: "Validation Rule Config",
      navGroup: "Billing",
      requiredPermission: "billing.rule_config.read",
      screen: RuleConfigEditor,
    },
    // --- eligibility center (§5.1 #13) ---
    {
      id: "billing.eligibility",
      path: "/billing/eligibility",
      title: "Eligibility Center",
      navGroup: "Billing",
      requiredPermission: "billing.eligibility.read",
      screen: EligibilityCenter,
    },
    // --- sequestration policy (§5.1 #14) ---
    {
      id: "billing.sequestration",
      path: "/billing/sequestration-policy",
      title: "Sequestration Policy",
      navGroup: "Billing",
      requiredPermission: "billing.sequestration_policy.read",
      screen: SequestrationPolicy,
    },
    // --- MAC credentials (§5.1 #15) ---
    {
      id: "billing.mac-credentials",
      path: "/billing/mac-credentials",
      title: "MAC Credentials",
      navGroup: "Billing",
      requiredPermission: "billing.mac_credential.read",
      screen: MacCredentials,
    },
    // --- override audit (§5.1 #16) ---
    {
      id: "billing.overrides",
      path: "/billing/overrides",
      title: "Override Audit",
      navGroup: "Billing",
      requiredPermission: "billing.validation.read_override",
      screen: OverrideAudit,
    },
    // --- billing metrics surface (§5.1 #17) ---
    {
      id: "billing.metrics",
      path: "/billing/metrics",
      title: "Billing Metrics",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read_metrics",
      screen: MetricsSurface,
    },
    // --- surveyor read view (§5.1 #21, surveyor/compliance) ---
    {
      id: "billing.surveyor-audit",
      path: "/admin/billing-audit",
      title: "Billing Audit (Surveyor)",
      navGroup: "Admin",
      requiredPermission: "billing.claim.read",
      screen: SurveyorReadView,
    },
  ],
};
