import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/10-hope — M10 screen registration (Track B, ADR-0030).
// The §5.1 HOPE Engine screens that have a backing M10 read route on the generated client: the org-wide
// Timepoint Dashboard (§5.2), the per-patient HOPE Timeline (§5.2), the SFV Worklist (§5.2), the HOPE
// Assessment Detail (§5.2), the Submission Worklist + Detail (§5.2), and the HQRP Compliance Dashboard
// (§5.2). Nav visibility is gated by the matching M10 permission key; the SERVER stays the only enforcement
// point (no frontend authz). The recording modal (§5.2, all five RFAs), the late-completion confirmation
// dialog, and the schedule-admin write surfaces fill in as their write paths harden.
import { lazy } from "react";
import type { ComponentType } from "react";
const HopeAssessmentDetail = lazy(() =>
  import("./hope-assessment-detail").then((m) => ({ default: m.HopeAssessmentDetail })),
);
const HopeDashboard = lazy(() =>
  import("./hope-dashboard").then((m) => ({ default: m.HopeDashboard })),
);
const HqrpComplianceDashboard = lazy(() =>
  import("./hqrp-compliance-dashboard").then((m) => ({ default: m.HqrpComplianceDashboard })),
);
const PatientHopeTimeline = lazy(() =>
  import("./patient-hope-timeline").then((m) => ({ default: m.PatientHopeTimeline })),
);
const SfvWorklist = lazy(() => import("./sfv-worklist").then((m) => ({ default: m.SfvWorklist })));
const SubmissionDetail = lazy(() =>
  import("./submission-detail").then((m) => ({ default: m.SubmissionDetail })),
);
const SubmissionWorklist = lazy(() =>
  import("./submission-worklist").then((m) => ({ default: m.SubmissionWorklist })),
);

export const hopeScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 10,
  slug: "10-hope",
  screens: [
    {
      // HOPE timepoint dashboard — org-wide operational hub; top-level nav surface.
      id: "hope.dashboard",
      path: "/hope",
      title: "HOPE",
      navGroup: "Clinical",
      requiredPermission: "hope.schedule.read",
      screen: HopeDashboard,
    },
    {
      // Patient HOPE timeline — reached from the patient chart "HOPE" tab; param path (no nav).
      id: "hope.patient-timeline",
      path: "/patients/:patientId/hope",
      title: "HOPE Timeline",
      requiredPermission: "hope.timepoint.read",
      screen: PatientHopeTimeline,
    },
    {
      // SFV worklist — open/overdue/missed symptom-follow-up visits across the org.
      id: "hope.sfv-worklist",
      path: "/hope/sfv",
      title: "SFV Worklist",
      navGroup: "Clinical",
      requiredPermission: "hope.sfv.read",
      screen: SfvWorklist,
    },
    {
      // HOPE assessment detail — reached from a timeline row; param path (no nav).
      id: "hope.assessment-detail",
      path: "/hope/assessments/:id",
      title: "HOPE Assessment",
      requiredPermission: "hope.timepoint.read",
      screen: HopeAssessmentDetail,
    },
    {
      // HOPE submission worklist — batches per ProviderEntity; compliance surface.
      id: "hope.submission-worklist",
      path: "/hope/submissions",
      title: "HOPE Submissions",
      navGroup: "Compliance",
      requiredPermission: "hope.submission.read",
      screen: SubmissionWorklist,
    },
    {
      // HOPE submission detail — reached from a submission row; param path (no nav).
      id: "hope.submission-detail",
      path: "/hope/submissions/:id",
      title: "HOPE Submission",
      requiredPermission: "hope.submission.read",
      screen: SubmissionDetail,
    },
    {
      // HQRP compliance dashboard — on-time / acceptance KPI surface.
      id: "hope.compliance",
      path: "/hope/compliance",
      title: "HQRP Compliance",
      navGroup: "Compliance",
      requiredPermission: "hope.dashboard.read",
      screen: HqrpComplianceDashboard,
    },
  ],
};
