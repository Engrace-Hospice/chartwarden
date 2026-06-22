import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/05-patient — M5 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import { GlobalSearchResults } from "./global-search";
import { PatientChart } from "./patient-chart";
import { PatientListCensus } from "./patient-list-census";

export const patientScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 5,
  slug: "05-patient",
  screens: [
    {
      id: "patient.census",
      path: "/patients",
      title: "Patients",
      navGroup: "Clinical",
      requiredPermission: "patient.read",
      screen: PatientListCensus,
    },
    {
      // Cross-cutting Global Search (FB-T11, partial — live M5 patient + M2 staff facets). Reached
      // from the shell top-nav search; also linkable at /search?q=. Server enforces every scope.
      id: "search.global",
      path: "/search",
      title: "Search",
      requiredPermission: "patient.read",
      screen: GlobalSearchResults,
    },
    {
      // Detail screen — reached from a census row; omitted from nav (param path).
      id: "patient.chart",
      path: "/patients/:id",
      title: "Patient Chart",
      requiredPermission: "patient.read",
      screen: PatientChart,
    },
  ],
};
