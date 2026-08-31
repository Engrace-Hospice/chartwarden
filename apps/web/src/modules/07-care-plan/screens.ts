import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/07-care-plan — M7 screen registration (Track B, ADR-0030).
// The §5 Care Plan (IPOC) screens that have a backing M7 read route on the generated client: the
// patient-scoped Care Plan View (§5.2), the Version History ledger (§5.1), and the patient-friendly
// Care Plan Summary (§5.2). Nav visibility is gated by the matching M7 permission key; the SERVER
// stays the only enforcement point (no frontend authz). The signing modal / draft editor / IDG-review
// screens fill in as their write surfaces harden (M7 §5.2).
import { lazy } from "react";
import type { ComponentType } from "react";
const CarePlanView = lazy(() =>
  import("./care-plan-view").then((m) => ({ default: m.CarePlanView })),
);
const CarePlanSummary = lazy(() =>
  import("./summary").then((m) => ({ default: m.CarePlanSummary })),
);
const CarePlanVersionHistory = lazy(() =>
  import("./version-history").then((m) => ({ default: m.CarePlanVersionHistory })),
);

export const carePlanScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 7,
  slug: "07-care-plan",
  screens: [
    {
      // Patient-scoped Care Plan View — reached from the patient chart "Care Plan" tab; param path (no nav).
      id: "care-plan.view",
      path: "/patients/:patientId/care-plan",
      title: "Care Plan",
      requiredPermission: "care_plan.read",
      screen: CarePlanView,
    },
    {
      // Version history — reached from the Care Plan View aside; param path (no nav).
      id: "care-plan.versions",
      path: "/care-plans/:planId/versions",
      title: "Care Plan — Version History",
      requiredPermission: "care_plan.read",
      screen: CarePlanVersionHistory,
    },
    {
      id: "care-plan.version-detail",
      path: "/care-plans/:planId/versions/:versionId",
      title: "Care Plan Version",
      requiredPermission: "care_plan.read",
      screen: CarePlanVersionHistory,
    },
    {
      // Patient-friendly summary — reached from the Care Plan View aside; param path (no nav).
      id: "care-plan.summary",
      path: "/care-plans/:planId/summary",
      title: "Care Plan Summary",
      requiredPermission: "care_plan.read_summary",
      screen: CarePlanSummary,
    },
  ],
};
