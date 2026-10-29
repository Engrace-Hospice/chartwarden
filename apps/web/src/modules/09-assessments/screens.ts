import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/09-assessments — M9 screen registration (Track B, ADR-0030).
// The §5 Clinical Assessments screens that have a backing M9 read route on the generated client: the
// patient-scoped Assessment Timeline (§5.2), the Per-scale Trend (§5.2), the per-patient Significant-change
// Inbox (§5.2), the Assessment Summary (§5.2), and the org-admin Scale-license Registry + Scale-policy Editor
// (§5.2). Nav visibility is gated by the matching M9 permission key; the SERVER stays the only enforcement point
// (no frontend authz).
//
// Recording: `record-assessment-modal.tsx` is a renderer for the instrument definition served by
// `GET /api/v1/scales` (nothing about a scale's items is written in this module) and offers only the
// `recordable` scales — the ones the server can score. With no open admission the Record control is
// absent. A detected significant change is produced inside the recording transaction (§9.6) and can be
// acknowledged from the per-patient inbox.
//
// STILL DEFERRED: the correction ceremony (`POST .../corrections`, which supersedes rather than edits
// and belongs beside a capture-detail surface that does not exist yet), the cosignature, and the
// scale-licence renewal + policy edits (admin surfaces whose reads are built).
import { lazy } from "react";
import type { ComponentType } from "react";
const AssessmentSummary = lazy(() =>
  import("./assessment-summary").then((m) => ({ default: m.AssessmentSummary })),
);
const AssessmentTimeline = lazy(() =>
  import("./assessment-timeline").then((m) => ({ default: m.AssessmentTimeline })),
);
const AssessmentDetail = lazy(() =>
  import("./assessment-detail").then((m) => ({ default: m.AssessmentDetail })),
);
const ScaleLicenseRegistry = lazy(() =>
  import("./scale-license-registry").then((m) => ({ default: m.ScaleLicenseRegistry })),
);
const ScalePolicyEditor = lazy(() =>
  import("./scale-policy-editor").then((m) => ({ default: m.ScalePolicyEditor })),
);
const ScaleTrend = lazy(() => import("./scale-trend").then((m) => ({ default: m.ScaleTrend })));
const SignificantChangeInbox = lazy(() =>
  import("./significant-change-inbox").then((m) => ({ default: m.SignificantChangeInbox })),
);

export const assessmentScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 9,
  slug: "09-assessments",
  screens: [
    {
      // Patient assessment timeline — reached from the patient chart "Assessments" tab; param path (no nav).
      id: "assessment.timeline",
      path: "/patients/:patientId/assessments",
      title: "Assessments",
      requiredPermission: "assessment.read",
      screen: AssessmentTimeline,
    },
    {
      // Full read-only capture detail; item values are projected by the server-side scale registry.
      id: "assessment.detail",
      path: "/patients/:patientId/assessments/:assessmentId",
      title: "Assessment Detail",
      requiredPermission: "assessment.read",
      screen: AssessmentDetail,
    },
    {
      // Per-scale trend — reached from a timeline row; param path (no nav).
      id: "assessment.scale-trend",
      path: "/patients/:patientId/scales/:scaleType",
      title: "Scale Trend",
      requiredPermission: "assessment.read_trend",
      screen: ScaleTrend,
    },
    {
      // Per-patient significant-change inbox — reached from the chart; param path (no nav).
      id: "assessment.changes",
      path: "/patients/:patientId/assessments/changes",
      title: "Significant Changes",
      requiredPermission: "assessment.read",
      screen: SignificantChangeInbox,
    },
    {
      // Assessment summary — latest value per scale; param path (no nav).
      id: "assessment.summary",
      path: "/patients/:patientId/assessments/summary",
      title: "Assessment Summary",
      requiredPermission: "assessment.read_summary",
      screen: AssessmentSummary,
    },
    {
      // Scale-license registry — org-admin top-level surface.
      id: "assessment.scale-licenses",
      path: "/admin/scales/licenses",
      title: "Scale Licenses",
      navGroup: "Admin",
      requiredPermission: "assessment.license_read",
      screen: ScaleLicenseRegistry,
    },
    {
      // Scale-policy editor — org-admin top-level surface.
      id: "assessment.scale-policies",
      path: "/admin/scales/policies",
      title: "Scale Policies",
      navGroup: "Admin",
      requiredPermission: "assessment.policy_read",
      screen: ScalePolicyEditor,
    },
  ],
};
