import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/10-hope — M10 screen registration (Track B, ADR-0030).
// The §5.1 HOPE Engine screens that have a backing M10 read route on the generated client: the org-wide
// Timepoint Dashboard (§5.2), the per-patient HOPE Timeline (§5.2), the SFV Worklist (§5.2), the HOPE
// Assessment Detail (§5.2), the Submission Worklist + Detail (§5.2), and the HQRP Compliance Dashboard
// (§5.2). Nav visibility is gated by the matching M10 permission key; the SERVER stays the only enforcement
// point (no frontend authz).
//
// F-031 (#91) — this header used to end "…fill in as their write paths harden", which made the
// screens.ts corpus the only accurate inventory of what the app could not do. It is accurate the other
// way now.
//
// WHAT IS BUILT: the §5.2 recording modal for all five RFAs, including the D12 late-completion
// confirmation and the past-deadline administrative override (Timepoint Dashboard, per open window,
// pinned to that window's schedule id and RFA; Patient HOPE Timeline, unscheduled); the SFV completion
// through its own `POST …/hope/sfv` endpoint (SFV Worklist, per open obligation); sign, correct
// (append-only, D7) and request-summary (Assessment Detail, each offered only in the status the server
// accepts); schedule skip (Timepoint Dashboard); and the route-20 schedule recompute (Patient Timeline).
//
// WHAT IS DELIBERATELY NOT BUILT, AND WHY — both are absences of a PRODUCER, not of a caller:
//
//   • The 13 HOPE sections with no item definitions. The CMS instrument has 17; four have item shapes
//     anywhere in this codebase (I, J's J2030/J2050/J2051, N) because those are what the pre-submission
//     rule set reads and the route boundary types. `packages/hope/src/sections/` holds exactly one file,
//     the required-items matrix — the spec's per-section schema modules were never written. The modal
//     captures the four that exist and offers nothing for the thirteen that do not; every recorded
//     assessment now carries one blocking finding per undefined section, so the gap is measurable on
//     the validation rail instead of being a sentence in a header.
//   • The two submission writes (#150). `assemble` inserts a batch with `itemCount: 0` and no items,
//     ignoring `planAssembleSubmissions`; `retry` flips a status nothing consumes. The pipeline behind
//     them is unreachable end to end. A button there would report success for work the server does not
//     do, so the Submission Worklist states the limitation on screen instead.
//
// F-067 (#91 AC5) — `e2e/specs/hope.spec.ts` drives the primary authored-then-signed path in a real
// browser: record an unscheduled HUV1 from the patient timeline, open the draft, sign it, and assert the
// server's own D4 evaluation created the 2-day SFV obligation. Writing it found that NONE of the writes
// above had ever reached a real server. `authorDiscipline` is the one field whose wire vocabulary is not
// the lowercase M3 role key — the route takes `RN`/`NP`/`MD` — and the recording modal offered raw role
// keys as the select's VALUES and sent one through an `as` cast, so every capture was refused 422; the
// correction modal took its attribution from `row.authorDiscipline`, which the read projection
// hard-codes to `""`; and `hope.correctionAuthorAllowed` compared a membership id to a user id, so the
// original signer was denied their own correction. Three dead writes, all green in `tsc`, the DOM suite
// and every fitness gate. The DOM suite could not see them: it asserted `authorDiscipline === "rn"`
// against a stub that 200s any non-GET, which encodes the defect as the expectation.
//
// The seed gap that spec sits on, left as a finding rather than papered over: `hope_timepoint_schedule`
// is EMPTY on a seeded stack, because schedules are written by the M6 outbox consumer rather than by any
// seed script. So the Timepoint Dashboard — the top-level nav surface — has no open window to record or
// skip, and the patient timeline's unscheduled capture is the only authoring path a seeded stack offers.
//
// Section EDITING of an existing draft (`PUT /hope/assessments/:id`) follows the first of those: this
// module renders no section editor, so a save-draft from here would send back exactly what it read.
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
