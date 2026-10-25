import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare screen registration (R2, ADR-0030,
// §5.1 / §10 PR-J). The read + write surface over the existing /api/v1/billing/* backend (37 routes). Each
// `requiredPermission` is the REAL §4.6 M23 key the matching route gates on
// (apps/backend/src/modules/23-billing-medicare/permission-keys.ts, mirrored into
// packages/auth/src/permissions/contributed.ts) — the server stays the authoritative enforcer; this only
// gates nav visibility. Billing screens sit under the "Billing" navGroup; the surveyor read view (#21,
// /admin/billing-audit) sits under "Admin".
import { lazy } from "react";
import type { ComponentType } from "react";
const AcknowledgmentsTimeline = lazy(() =>
  import("./acknowledgments-timeline").then((m) => ({ default: m.AcknowledgmentsTimeline })),
);
const ArDashboard = lazy(() => import("./ar-dashboard").then((m) => ({ default: m.ArDashboard })));
const ClaimAssemblyWizard = lazy(() =>
  import("./claim-assembly-wizard").then((m) => ({ default: m.ClaimAssemblyWizard })),
);
const ClaimEditor = lazy(() => import("./claim-editor").then((m) => ({ default: m.ClaimEditor })));
const ClaimWorkbench = lazy(() =>
  import("./claim-workbench").then((m) => ({ default: m.ClaimWorkbench })),
);
const EligibilityCenter = lazy(() =>
  import("./eligibility-center").then((m) => ({ default: m.EligibilityCenter })),
);
const MacCredentials = lazy(() =>
  import("./mac-credentials").then((m) => ({ default: m.MacCredentials })),
);
const MetricsSurface = lazy(() =>
  import("./metrics-surface").then((m) => ({ default: m.MetricsSurface })),
);
const NoeDetail = lazy(() => import("./noe-detail").then((m) => ({ default: m.NoeDetail })));
const NoeQueue = lazy(() => import("./noe-queue").then((m) => ({ default: m.NoeQueue })));
const NotrDetail = lazy(() => import("./notr-detail").then((m) => ({ default: m.NotrDetail })));
const NotrQueue = lazy(() => import("./notr-queue").then((m) => ({ default: m.NotrQueue })));
const TransferNotices = lazy(() =>
  import("./transfer-notices").then((m) => ({ default: m.TransferNotices })),
);
const PatientClaims = lazy(() =>
  import("./patient-claims").then((m) => ({ default: m.PatientClaims })),
);
const OverrideAudit = lazy(() =>
  import("./override-audit").then((m) => ({ default: m.OverrideAudit })),
);
const RateTables = lazy(() => import("./rate-tables").then((m) => ({ default: m.RateTables })));
const RuleConfigEditor = lazy(() =>
  import("./rule-config").then((m) => ({ default: m.RuleConfigEditor })),
);
const SequestrationPolicy = lazy(() =>
  import("./sequestration-policy").then((m) => ({ default: m.SequestrationPolicy })),
);
const SubmissionsTimeline = lazy(() =>
  import("./submissions-timeline").then((m) => ({ default: m.SubmissionsTimeline })),
);
const SurveyorReadView = lazy(() =>
  import("./surveyor-read-view").then((m) => ({ default: m.SurveyorReadView })),
);
const DdeQueue = lazy(() => import("./dde-queue").then((m) => ({ default: m.DdeQueue })));
const WageIndexes = lazy(() => import("./wage-indexes").then((m) => ({ default: m.WageIndexes })));
const ValidationWorklist = lazy(() =>
  import("./validation-worklist").then((m) => ({ default: m.ValidationWorklist })),
);
const BillingWorkQueue = lazy(() =>
  import("./work-queue").then((m) => ({ default: m.BillingWorkQueue })),
);

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
    // --- the unified work queue: claims, NOE/NOTR notices and DDE items in one list (read-only; links out) ---
    {
      id: "billing.work-queue",
      path: "/billing/queue",
      title: "Billing Work Queue",
      navGroup: "Billing",
      requiredPermission: "billing.claim.read",
      screen: BillingWorkQueue,
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
    // --- patient chart Claims tab (2026-09-25 redesign) — reached from the chart tab strip, no nav ---
    {
      id: "billing.patient-claims",
      path: "/patients/:patientId/claims",
      title: "Claims",
      requiredPermission: "billing.claim.read",
      screen: PatientClaims,
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
    // --- Medicare transfer notices (TOB 8xC / 8xD; CMS Pub. 100-04 ch. 11 §20.1.3–§20.1.4) — the receiving
    // hospice's change-of-hospice notice; rides the NOE keys (CMS calls it a "transfer Notice of Election").
    {
      id: "billing.transfer-notices",
      path: "/billing/transfer-notices",
      title: "Transfer Notices",
      navGroup: "Billing",
      requiredPermission: "billing.noe.read",
      screen: TransferNotices,
    },
    // --- DDE work queue: human work tracking for Medicare Direct Data Entry (ADR-0052) ---
    {
      id: "billing.dde-queue",
      path: "/billing/dde",
      title: "DDE Work Queue",
      navGroup: "Billing",
      requiredPermission: "billing.dde.read",
      screen: DdeQueue,
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
    // --- hospice rate table + HQRP status + CMS national reference (F-210, FY2027 workstream E) ---
    {
      id: "billing.rate-tables",
      path: "/billing/rate-tables",
      title: "Hospice Rates",
      navGroup: "Billing",
      requiredPermission: "billing.rate_table.read",
      screen: RateTables,
    },
    // --- tenant-entered CMS hospice wage index per CCN + fiscal year (F-211; GAP-125) ---
    {
      id: "billing.wage-indexes",
      path: "/billing/wage-indexes",
      title: "Wage Index",
      navGroup: "Billing",
      requiredPermission: "billing.wage_index.read",
      screen: WageIndexes,
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
