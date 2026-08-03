import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/13-emar — M13 eMAR screen registration (Track B, ADR-0030, M13-T10).
// The §6.1 administration (eMAR) read screens that have a backing M13 read route on the generated client: the
// Patient eMAR (§6.1 #1, the bedside MAR-grid projection), the Administration Detail (§6.1 #11), the IV
// Continuous Session (§6.1 #5), the patient Missed-Dose inbox (§6.1 #8), the Reconciliation Worksheet (§6.1 #6),
// the Comfort Kit view (§6.1 #7), and the Administration Policy admin (§6.1 #12). Nav visibility is gated by the
// matching M13 permission key; the SERVER stays the only enforcement point (no frontend authz, ADR-0030 —
// out-of-scope resources 404, never 403; SUD-flagged rows redacted/skipped server-side). The Single-Dose / PRN /
// Witness administration modals, the IV titrate/stop, the missed-dose acknowledge, the reconciliation decide /
// finalize, and the comfort-kit acknowledge-return write surfaces fill in as those write paths harden. The M22
// eMAR PDF (apps/admin) and M28 FHIR MedicationAdministration projection are deferred (Wave F/H deny-stubs).
import { lazy } from "react";
import type { ComponentType } from "react";
const AdministrationDetail = lazy(() =>
  import("./administration-detail").then((m) => ({ default: m.AdministrationDetail })),
);
const AdministrationPolicy = lazy(() =>
  import("./administration-policy").then((m) => ({ default: m.AdministrationPolicy })),
);
const ComfortKitView = lazy(() =>
  import("./comfort-kit-view").then((m) => ({ default: m.ComfortKitView })),
);
const IvSession = lazy(() => import("./iv-session").then((m) => ({ default: m.IvSession })));
const MissedDoseInbox = lazy(() =>
  import("./missed-dose-inbox").then((m) => ({ default: m.MissedDoseInbox })),
);
const PatientEmar = lazy(() => import("./patient-emar").then((m) => ({ default: m.PatientEmar })));
const ReconciliationWorksheet = lazy(() =>
  import("./reconciliation-worksheet").then((m) => ({ default: m.ReconciliationWorksheet })),
);

export const emarScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 13,
  slug: "13-emar",
  screens: [
    {
      // Patient eMAR — the bedside default landing surface; reached from the patient chart "eMAR" tab.
      id: "emar.patient-emar",
      path: "/patients/:patientId/emar",
      title: "eMAR",
      requiredPermission: "administration.read",
      screen: PatientEmar,
    },
    {
      // Administration detail — read-only audit-boundary detail; reached from the eMAR administrations list.
      id: "emar.administration-detail",
      path: "/patients/:patientId/administrations/:id",
      title: "Administration",
      requiredPermission: "administration.read",
      screen: AdministrationDetail,
    },
    {
      // IV continuous session — the IPU start→titrate→stop segment sequence; param path (no nav).
      id: "emar.iv-session",
      path: "/patients/:patientId/iv-sessions/:sessionId",
      title: "IV Continuous Session",
      requiredPermission: "administration.read",
      screen: IvSession,
    },
    {
      // Missed-dose inbox — patient-scoped queue of unacknowledged misses (route requires `patient`).
      id: "emar.missed-doses",
      path: "/patients/:patientId/missed-doses",
      title: "Missed Doses",
      requiredPermission: "administration.read_missed",
      screen: MissedDoseInbox,
    },
    {
      // Reconciliation worksheet — per-line decision view; reached from the patient chart; param path (no nav).
      id: "emar.reconciliation-worksheet",
      path: "/patients/:patientId/reconciliation/:worksheetId",
      title: "Medication Reconciliation",
      requiredPermission: "reconciliation.read",
      screen: ReconciliationWorksheet,
    },
    {
      // Comfort-kit view — drawdown/disposal detail; reached from the patient chart; param path (no nav).
      id: "emar.comfort-kit",
      path: "/patients/:patientId/comfort-kit/:deploymentId",
      title: "Comfort Kit",
      requiredPermission: "comfort_kit.read",
      screen: ComfortKitView,
    },
    {
      // Administration policy admin — grace window + PRN reassessment defaults (org-scoped, step-up).
      id: "emar.administration-policy",
      path: "/admin/administration-policy",
      title: "Administration Policy",
      navGroup: "Admin",
      requiredPermission: "administration.admin.policy",
      screen: AdministrationPolicy,
    },
  ],
};
