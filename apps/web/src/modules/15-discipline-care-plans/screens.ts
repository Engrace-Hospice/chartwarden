import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/15-discipline-care-plans — M15 Discipline Care Plans screen registration
// (Track B / ADR-0030, §5.1). The read + write surface over the live /api/v1/discipline-plans +
// /api/v1/volunteer-* backend (28 routes, M15-T06).
//
// Each `requiredPermission` is the REAL §4.4 M15 key the matching route gates on
// (apps/backend/src/modules/15-discipline-care-plans/permission-keys.ts → `M15_CONTRIBUTED_PERMISSIONS` in
// @wardenx/auth) — this gates NAV VISIBILITY only; the server stays the authoritative enforcer, and an
// out-of-scope plan is a non-leaking 404 from the server, never a frontend hide.
//
// The patient-scoped clinical surfaces carry no `navGroup`: they are param routes reached from the patient
// chart's module rail and from the plans index, exactly as M7's Care Plan screens are. The two 418.78
// workforce surfaces are tenant-wide and DO sit in nav, under "Admin" — they carry no patient identifier
// (which is why their routes waive the PHI read-audit with a documented justification).
//
// §5.1 modals are NOT separate registry entries — the sign ceremony, the supervisory-visit capture, the
// volunteer-assignment gate check and the gate create/correct/revoke forms live inside their parent
// screens, because each one needs the parent's already-read row `version` for its `If-Match`.
import { lazy } from "react";
import type { ComponentType } from "react";
const AidePocEditor = lazy(() =>
  import("./aide-poc-editor").then((m) => ({ default: m.AidePocEditor })),
);
const AidePocView = lazy(() => import("./aide-poc-view").then((m) => ({ default: m.AidePocView })));
const AssessmentEditor = lazy(() =>
  import("./assessment-editor").then((m) => ({ default: m.AssessmentEditor })),
);
const DisciplinePlansIndex = lazy(() =>
  import("./plans-index").then((m) => ({ default: m.DisciplinePlansIndex })),
);
const DisciplinePlansSummary = lazy(() =>
  import("./plans-summary").then((m) => ({ default: m.DisciplinePlansSummary })),
);
const DisciplineVersionHistory = lazy(() =>
  import("./version-history").then((m) => ({ default: m.DisciplineVersionHistory })),
);
const IdgRevisionReview = lazy(() =>
  import("./idg-revision-review").then((m) => ({ default: m.IdgRevisionReview })),
);
const MswPlanView = lazy(() => import("./msw-plan").then((m) => ({ default: m.MswPlanView })));
const SpiritualPlanView = lazy(() =>
  import("./spiritual-plan").then((m) => ({ default: m.SpiritualPlanView })),
);
const VolunteerComplianceGates = lazy(() =>
  import("./volunteer-compliance").then((m) => ({ default: m.VolunteerComplianceGates })),
);
const VolunteerHourRatio = lazy(() =>
  import("./volunteer-ratio").then((m) => ({ default: m.VolunteerHourRatio })),
);
const VolunteerPlanView = lazy(() =>
  import("./volunteer-plan").then((m) => ({ default: m.VolunteerPlanView })),
);

export const disciplinePlanScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 15,
  slug: "15-discipline-care-plans",
  screens: [
    // --- the four-plan grid (§5.1 #1) ---
    {
      id: "discipline-plan.index",
      path: "/patients/:patientId/discipline-plans",
      title: "Discipline Plans",
      requiredPermission: "discipline_plan.read",
      screen: DisciplinePlansIndex,
    },
    // --- the four kind views (§5.1 #2, #6, #8, #9) + the Aide POC editor (#3) ---
    {
      id: "discipline-plan.aide-poc",
      path: "/patients/:patientId/discipline-plans/aide-poc",
      title: "Aide Plan of Care",
      requiredPermission: "discipline_plan.read",
      screen: AidePocView,
    },
    {
      id: "discipline-plan.aide-poc.edit",
      path: "/patients/:patientId/discipline-plans/aide-poc/:versionId/edit",
      title: "Aide Plan of Care — Edit",
      requiredPermission: "discipline_plan.author",
      screen: AidePocEditor,
    },
    {
      id: "discipline-plan.msw",
      path: "/patients/:patientId/discipline-plans/msw-plan",
      title: "MSW Plan",
      requiredPermission: "discipline_plan.read",
      screen: MswPlanView,
    },
    {
      id: "discipline-plan.assessment",
      path: "/patients/:patientId/discipline-plans/msw-plan/:planId/assessments/:assessmentId",
      title: "Discipline Assessment",
      requiredPermission: "discipline_assessment.author",
      screen: AssessmentEditor,
    },
    {
      id: "discipline-plan.spiritual",
      path: "/patients/:patientId/discipline-plans/spiritual-plan",
      title: "Spiritual Care Plan",
      requiredPermission: "discipline_plan.read",
      screen: SpiritualPlanView,
    },
    {
      id: "discipline-plan.volunteer",
      path: "/patients/:patientId/discipline-plans/volunteer-plan",
      title: "Volunteer Plan",
      requiredPermission: "discipline_plan.read",
      screen: VolunteerPlanView,
    },
    // --- the printable summary (§5.1 #15) — the same projection M31's portal reads ---
    {
      id: "discipline-plan.summary",
      path: "/patients/:patientId/discipline-plans/summary",
      title: "Discipline Plans — Summary",
      requiredPermission: "discipline_plan.read_summary",
      screen: DisciplinePlansSummary,
    },
    // --- version chain (§5.1 #13) + post-IDG finalization (§5.1 #14) ---
    {
      id: "discipline-plan.versions",
      path: "/patients/:patientId/discipline-plans/:kind/versions",
      title: "Discipline Plan — Version History",
      requiredPermission: "discipline_plan.read",
      screen: DisciplineVersionHistory,
    },
    {
      id: "discipline-plan.idg-revision",
      path: "/patients/:patientId/discipline-plans/:kind/idg-revisions/:versionId",
      title: "IDG Revision Review",
      requiredPermission: "discipline_plan.idg_revise",
      screen: IdgRevisionReview,
    },
    // --- the tenant-wide 418.78 volunteer surfaces (§5.1 #11, #12) ---
    {
      id: "volunteer.compliance",
      path: "/admin/volunteer-compliance",
      title: "Volunteer Compliance",
      navGroup: "Admin",
      requiredPermission: "volunteer_compliance.read",
      screen: VolunteerComplianceGates,
    },
    {
      id: "volunteer.ratio",
      path: "/admin/volunteer-ratio",
      title: "Volunteer 5% Ratio",
      navGroup: "Admin",
      requiredPermission: "volunteer_compliance.read_ratio",
      screen: VolunteerHourRatio,
    },
  ],
};
