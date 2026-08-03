import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/30-quality — M30 screen registration (Track B, ADR-0030).
//
// M30's first web surface. Until now the module had no `apps/web` codePath in the manifest, so
// `arch:parity` would have failed before any file landed — the manifest entry is the actual unblock.
import { lazy } from "react";
import type { ComponentType } from "react";
const QapiIncidents = lazy(() =>
  import("./qapi-incidents").then((m) => ({ default: m.QapiIncidents })),
);
const QualityHub = lazy(() => import("./quality-hub").then((m) => ({ default: m.QualityHub })));

export const qualityScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 30,
  slug: "30-quality",
  screens: [
    {
      id: "quality.hub",
      path: "/quality",
      title: "Quality",
      navGroup: "Compliance",
      requiredPermission: "quality.measure.read",
      screen: QualityHub,
    },
    {
      id: "quality.qapi-incidents",
      path: "/quality/qapi",
      title: "QAPI & Incidents",
      navGroup: "Compliance",
      requiredPermission: "incident.read",
      screen: QapiIncidents,
    },
  ],
};
