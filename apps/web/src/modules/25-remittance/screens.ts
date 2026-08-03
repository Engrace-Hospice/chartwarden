import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/25-remittance — M25 Remittance & Denials screen registration (R2, ADR-0030, §5).
// The read surface over the live /api/v1/remittance|denials|appeals|taxonomy/* backend (31 routes). Each
// `requiredPermission` is the REAL §4.6 M25 key the matching route gates on (already in
// packages/auth/src/permissions/contributed.ts via Phase 3a) — the server stays the authoritative enforcer;
// this gates nav visibility only. The four M25 surfaces sit under the "Billing" navGroup (revenue cycle).
import { lazy } from "react";
import type { ComponentType } from "react";
const AppealTracker = lazy(() =>
  import("./appeal-tracker").then((m) => ({ default: m.AppealTracker })),
);
const DenialWorklist = lazy(() =>
  import("./denial-worklist").then((m) => ({ default: m.DenialWorklist })),
);
const RemittanceWorklist = lazy(() =>
  import("./remittance-worklist").then((m) => ({ default: m.RemittanceWorklist })),
);
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
      id: "remittance.appeals",
      path: "/remittance/appeals",
      title: "Appeals",
      navGroup: "Billing",
      requiredPermission: "appeal.read",
      screen: AppealTracker,
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
