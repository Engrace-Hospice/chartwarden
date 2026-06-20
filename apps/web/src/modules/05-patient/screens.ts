// apps/web/src/modules/05-patient — M5 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
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
      // Detail screen — reached from a census row; omitted from nav (param path).
      id: "patient.chart",
      path: "/patients/:id",
      title: "Patient Chart",
      requiredPermission: "patient.read",
      screen: PatientChart,
    },
  ],
};
