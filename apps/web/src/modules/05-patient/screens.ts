import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/05-patient — M5 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const GlobalSearchResults = lazy(() =>
  import("./global-search").then((m) => ({ default: m.GlobalSearchResults })),
);
const PatientChart = lazy(() =>
  import("./patient-chart").then((m) => ({ default: m.PatientChart })),
);
const PatientPrivacy = lazy(() =>
  import("./patient-privacy").then((m) => ({ default: m.PatientPrivacy })),
);
const PrivacyQueue = lazy(() =>
  import("./privacy-queue").then((m) => ({ default: m.PrivacyQueue })),
);
const PatientListCensus = lazy(() =>
  import("./patient-list-census").then((m) => ({ default: m.PatientListCensus })),
);

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
      // from the shell top-nav search, which hands the needle over IN MEMORY — `/search` is
      // deliberately NOT linkable with a term (GAP-080: a patient name or MRN in the URL persists
      // in history/omnibox/session-restore). Server enforces every scope.
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
    {
      // M5 §5.1 "Privacy flags" — the Privacy Officer's per-patient view (snapshot, origin, consent
      // state, WardenLens detections, timeline) + the §4.2 resync. Reached from the queue below and the
      // chart's privacy surfaces; omitted from nav (param path).
      id: "patient.privacy",
      path: "/patients/:id/privacy",
      title: "Privacy restrictions",
      requiredPermission: "privacy.admin",
      screen: PatientPrivacy,
    },
    {
      // The officer's work queue (patients with a restriction or a stale snapshot, by origin). Lands
      // under Administration (the `/compliance` claim in shell/primary-nav.ts).
      id: "privacy.restricted-patients",
      path: "/compliance/privacy",
      title: "Privacy Restrictions",
      navGroup: "Admin",
      requiredPermission: "privacy.admin",
      screen: PrivacyQueue,
    },
  ],
};
