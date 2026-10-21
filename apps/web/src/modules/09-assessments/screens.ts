import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/09-assessments — M9 screen registration (Track B, ADR-0030).
// The §5 Clinical Assessments screens that have a backing M9 read route on the generated client: the
// patient-scoped Assessment Timeline (§5.2), the Per-scale Trend (§5.2), the per-patient Significant-change
// Inbox (§5.2), the Assessment Summary (§5.2), and the org-admin Scale-license Registry + Scale-policy Editor
// (§5.2). Nav visibility is gated by the matching M9 permission key; the SERVER stays the only enforcement point
// (no frontend authz).
//
// #91 / F-067 — SCALES CAN BE RECORDED NOW, and a detected change can be acknowledged. Both were
// blocked on the server rather than on the write routes:
//
//   • The INSTRUMENT DEFINITION was on nobody's wire. `POST .../assessments` publishes `data` as a bare
//     object, and which items a scale needs — how many, what kind, what range, which option values —
//     existed only as TypeScript interfaces in `@chartwarden/assessments`, which a client cannot read.
//     `SCALE_CATALOG`'s own header calls itself "the single source the record-modal scale picker (T07)
//     ... read"; there was no record modal. `GET /api/v1/scales` is that definition, and
//     `record-assessment-modal.tsx` is a RENDERER for it — nothing about PPS's five axes or ESAS-r's
//     nine items is written in this module. A new scale's form appears when its module lands.
//   • TEN OF THE FOURTEEN SCALES CANNOT BE CAPTURED. `scoring.ts` registers four scorers and raises
//     `SCALE_SCORER_UNAVAILABLE` — a **500** — for the rest, all of which are in the route's own
//     `scaleType` enum. `hasScorer` is documented as "the form-gating ... check" and nothing gated on
//     it. The picker offers `recordable` scales only, which is the server's answer, not a list copied
//     here.
//   • `admissionId` had no patient-scoped lookup until F-065 (see #161). With no open admission the
//     Record control is absent rather than present-and-certain-to-fail.
//
// F-076 (#91 AC5) — `e2e/specs/assessments.spec.ts` drives the primary path in a real browser: capture a
// PPS, let the SERVER score it, and watch the decline it causes reach the significant-change queue and be
// acknowledged. Writing it found that the third step could never happen. `detectSignificantChanges` has
// been pure, complete and unit-tested since M9-T08 — its own header describes "the pure evaluators THE
// RECORDING TRANSACTION runs after scoring" — and NOTHING called it. No code path inserted a
// `significant_change_event`: four consumers read that table (the worklist, the seam store, the escalation
// cron and the eraser) and none wrote to it. So the queue was empty for every patient in every tenant, the
// Acknowledge action added just above could never be pressed, the escalation cron had nothing to escalate,
// and the catalogued `m9.assessment.significant_change` was never emitted. Same shape as
// `hope_submission_item` (#150) and the F-029 step-up routes: a finished core with no caller, which every
// unit test passes. The producer now runs inside the write transaction (§9.6), and
// `m9-assessments-write.live.test.ts` pins both an absolute rule and a windowed drop against real rows.
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
