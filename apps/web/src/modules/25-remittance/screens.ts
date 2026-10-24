import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/25-remittance — M25 Remittance & Denials screen registration (R2, ADR-0030, §5).
// The read surface over the live /api/v1/remittance|denials|appeals|taxonomy/* backend (31 routes). Each
// `requiredPermission` is the REAL §4.6 M25 key the matching route gates on (already in
// packages/auth/src/permissions/contributed.ts via Phase 3a) — the server stays the authoritative enforcer;
// this gates nav visibility only. The four M25 surfaces sit under the "Billing" navGroup (revenue cycle).
import { lazy } from "react";
import type { ComponentType } from "react";
const AuditWorklist = lazy(() =>
  import("./audit-worklist").then((m) => ({ default: m.AuditWorklist })),
);
const AdrWorklist = lazy(() => import("./adr-worklist").then((m) => ({ default: m.AdrWorklist })));
const AppealTracker = lazy(() =>
  import("./appeal-tracker").then((m) => ({ default: m.AppealTracker })),
);
const DenialWorklist = lazy(() =>
  import("./denial-worklist").then((m) => ({ default: m.DenialWorklist })),
);
const RemittanceWorklist = lazy(() =>
  import("./remittance-worklist").then((m) => ({ default: m.RemittanceWorklist })),
);
const PayerAppealPaths = lazy(() =>
  import("./payer-appeal-paths").then((m) => ({ default: m.PayerAppealPaths })),
);
const RepresentativeFormSettings = lazy(() =>
  import("./representative-form-settings").then((m) => ({
    default: m.RepresentativeFormSettings,
  })),
);
const TpeTracker = lazy(() => import("./tpe-tracker").then((m) => ({ default: m.TpeTracker })));
const TaxonomyOverlay = lazy(() =>
  import("./taxonomy-overlay").then((m) => ({ default: m.TaxonomyOverlay })),
);

export const remittanceScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 25,
  slug: "25-remittance",
  screens: [
    {
      id: "remittance.worklist",
      path: "/remittance",
      title: "Remittance",
      navGroup: "Billing",
      requiredPermission: "remittance.read",
      screen: RemittanceWorklist,
    },
    {
      id: "remittance.denials",
      path: "/remittance/denials",
      title: "Denials",
      navGroup: "Billing",
      requiredPermission: "denial.worklist.read",
      screen: DenialWorklist,
    },
    {
      id: "remittance.adrs",
      path: "/remittance/adrs",
      title: "ADR Requests",
      navGroup: "Billing",
      requiredPermission: "adr.read",
      screen: AdrWorklist,
    },
    {
      id: "remittance.audits",
      path: "/remittance/audits",
      title: "Audit Requests",
      navGroup: "Billing",
      requiredPermission: "audit_request.read",
      screen: AuditWorklist,
    },
    {
      id: "remittance.appeals",
      path: "/remittance/appeals",
      title: "Appeals",
      navGroup: "Billing",
      requiredPermission: "appeal.read",
      screen: AppealTracker,
    },
    {
      id: "remittance.tpe",
      path: "/remittance/tpe",
      title: "TPE Program",
      navGroup: "Billing",
      requiredPermission: "tpe.read",
      screen: TpeTracker,
    },
    {
      id: "remittance.payer-appeal-paths",
      path: "/remittance/payer-appeal-paths",
      title: "Payer Appeal Paths",
      navGroup: "Billing",
      requiredPermission: "payer_appeal_path.read",
      screen: PayerAppealPaths,
    },
    {
      id: "remittance.representative-forms",
      path: "/remittance/representative-forms",
      title: "Appointment Forms",
      navGroup: "Billing",
      requiredPermission: "representative_form.configure",
      screen: RepresentativeFormSettings,
    },
    {
      id: "remittance.taxonomy",
      path: "/remittance/taxonomy",
      title: "Denial Taxonomy",
      navGroup: "Billing",
      requiredPermission: "taxonomy.read",
      screen: TaxonomyOverlay,
    },
  ],
};
