# WardenX HOPE Phase 2 UI, Navigation & Operational Workflow Report

Date: 2026-08-28

## A. Existing Frontend Found

Existing M10 web routes found before the admission-scoped Phase 2 work:

- `hope.dashboard`: `/hope`
- `hope.patient-timeline`: `/patients/:patientId/hope`
- `hope.sfv-worklist`: `/hope/sfv`
- `hope.assessment-detail`: `/hope/assessments/:id`
- `hope.submission-worklist`: `/hope/submissions`
- `hope.submission-detail`: `/hope/submissions/:id`
- `hope.compliance`: `/hope/compliance`

Phase 2 added:

- `hope.admission-overview`: `/admissions/:admissionId/hope`
- `hope.timepoint-capture`: `/admissions/:admissionId/hope/timepoints/:kind`
- `hope.sfv-capture`: `/admissions/:admissionId/hope/sfv/:sfvId`

## B. Files Changed

- `apps/backend/src/modules/10-hope/routes/service.ts`
- `apps/backend/src/modules/10-hope/hope-route-service-db.ts`
- `apps/backend/src/modules/10-hope/routes/hope-typebox.ts`
- `apps/backend/src/modules/10-hope/routes/hope-routes.ts`
- `apps/backend/src/modules/10-hope/index.ts`
- `apps/backend/__tests__/hope-routes.test.ts`
- `apps/web/src/modules/10-hope/admission-hope-overview.tsx`
- `apps/web/src/modules/10-hope/hope-capture-workspace.tsx`
- `apps/web/src/modules/10-hope/hope-assessment-detail.tsx`
- `apps/web/src/modules/10-hope/hope-status.ts`
- `apps/web/src/modules/10-hope/screens.ts`
- `apps/web/src/modules/10-hope/__tests__/admission-hope-overview.dom.test.tsx`
- `apps/web/src/modules/10-hope/__tests__/hope-capture-workspace.dom.test.tsx`
- `apps/web/src/modules/06-admission/admission-detail.tsx`
- `apps/web/src/modules/06-admission/__tests__/admission-detail.dom.test.tsx`
- `scripts/openapi/enrichments.ts`
- `packages/ui/src/core/api/schema.ts`
- `docs/cartography/hope_report.md`

Generated before the later instruction not to read or touch OpenAPI:

- `docs/api/openapi.json`

After that instruction, no command was run that reads or writes `docs/api/openapi.json`.

## C. HOPE Summary/Read Model

Implemented `GET /api/v1/admissions/:admissionId/hope` as the coherent operational summary endpoint. The route uses M10 permission/read-audit conventions:

- permission: `hope.timepoint.read`
- read audit resource kind: `hope_workflow`
- resource id: `admissionId`

Final response shape:

```ts
{
  admissionId: string,
  patientId: string | null,
  admissionStatus: string | null,
  admissionAt: string | null,
  activatedAt: string | null,
  dischargedAt: string | null,
  admissionAssessment: HopeWorkflowTimepointView,
  huv1: HopeWorkflowTimepointView,
  huv2: HopeWorkflowTimepointView,
  sfvs: HopeWorkflowSfvView[],
  dischargeAssessment: HopeWorkflowTimepointView,
  summary: {
    actionableCount: number,
    overdueCount: number,
    completedCount: number,
    nextDeadline: string | null
  }
}
```

Timepoint status is produced server-side from M10 schedules and assessments:

- missing fixed Admission/HUV schedule: `workflow_not_initialized`
- missing discharge schedule: `not_applicable`
- persisted terminal schedule states: `completed`, `expired`, `skipped`
- before `windowOpensAt`: `upcoming`
- within window: `open`
- after `windowClosesAt` but before `lateDeadlineAt`: `late`
- after `lateDeadlineAt`: `expired`

SFV status comes from `symptom_follow_up_visit` rows and existing M10 SFV lifecycle state. React formats dates only; it does not calculate HUV windows, discharge applicability, or SFV triggers.

## D. Final Navigation

The clinician path is now:

```text
Admission
-> HOPE
-> Admission RFA / HUV1 / HUV2 / SFV / Discharge RFA
```

Admission Detail shows a compact HOPE panel with fixed-item statuses, SFV open count, next deadline, and `Open HOPE`. The HOPE overview routes directly to contextual capture screens:

- `Complete Admission RFA` -> `/admissions/:admissionId/hope/timepoints/01_admission`
- `Complete HUV1` -> `/admissions/:admissionId/hope/timepoints/02_huv1`
- `Complete HUV2` -> `/admissions/:admissionId/hope/timepoints/03_huv2`
- `Complete Follow-Up` -> `/admissions/:admissionId/hope/sfv/:sfvId`
- `Complete Discharge Assessment` -> `/admissions/:admissionId/hope/timepoints/05_discharge`

The assessment detail screen now has an `Admission HOPE` return action when the assessment DTO includes `admissionId`.

## E. Admission RFA UI

The Admission RFA appears as `HOPE Admission Assessment` with subtitle `Admission RFA`. It displays backend-provided window dates, late deadline, completion date, and status. Open/late states expose `Complete Admission RFA`; completed state exposes `View Assessment`; unavailable or missing schedules are not confused with `not_applicable`.

## F. HUV1 UI

HUV1 is a first-class card, not an anonymous timepoint row. It displays status, window, late deadline, completion state, and the correct next action. Late HUV1 uses backend status `late`, asks explicitly for a late completion reason, and sends `lateCompletionReasonCode` only when the user selects it.

## G. HUV2 UI

HUV2 uses the shared HOPE timepoint card and contextual capture route. The UI reads `upcoming`, `open`, `late`, `completed`, `expired`, `skipped`, `not_applicable`, and `workflow_not_initialized` from the summary response; it does not duplicate HUV timing rules in React.

## H. SFV UI

SFVs render in a separate section from fixed RFAs. Multiple SFVs are supported as a list. Each row shows status, due date, completion date when present, and source context from backend-safe fields such as triggering RFA kind. The UI does not inspect J2051 answer paths and does not create triggers.

Open/overdue SFVs route to the real `recordSfv` workflow. Completed SFVs route to their completing assessment when available. Missed/terminal SFVs remain view-only or unavailable according to backend state.

## I. Discharge RFA UI

The discharge card displays `Not applicable` when M10 has not materialized a discharge schedule. When the M10 `05_discharge` schedule exists, the same card shows the backend-provided window/status and offers `Complete Discharge Assessment` only for actionable states. Applicability is not derived from `admission.status` in the frontend.

## J. M9 Integration

Admission Detail keeps the M9 clinical admission workflow separate from the M10 HOPE Admission RFA. The HOPE overview includes a distinct `Clinical Admission Assessment` section with an `Open M9 Assessments` link when `patientId` is available. No M9 assessment records or timing rules were merged into M10.

## K. Historical Admissions

The summary read model distinguishes missing/inconsistent workflow data from true non-applicability:

- Admission/HUV schedule missing -> `workflow_not_initialized`
- Discharge schedule absent before M10 makes it applicable -> `not_applicable`

The frontend shows missing initialization as an operational data condition and does not fabricate schedules. No new automatic backfill endpoint was added in Phase 2; Phase 1 already added event-driven materialization for newly activated/discharged admissions.

## L. Tests

Backend:

- `apps/backend/__tests__/hope-routes.test.ts` proves the admission-scoped HOPE summary route returns fixed RFA state and SFVs from M10 without frontend table-by-table reconstruction.
- Existing targeted M10 route/job/consumer/read-audit tests were rerun to guard Phase 1 behavior around scheduling, SFV lifecycle, and read audit coverage.

Frontend:

- `admission-hope-overview.dom.test.tsx` proves Admission RFA, HUV1, HUV2, Discharge RFA, SFVs, and the M9/M10 distinction render from backend-provided data.
- The same overview tests prove HUV, SFV, and Discharge navigation goes to contextual workflow routes with no raw RFA picker.
- `hope-capture-workspace.dom.test.tsx` proves late capture asks for a late reason, structured backend errors are rendered, and SFV completion uses backend-created SFV context.
- `admission-detail.dom.test.tsx` proves Admission Detail exposes the compact HOPE entry point while keeping the existing readiness workflow intact.

## M. Verification

Passed:

- `bun run typecheck`
- `bun run test apps/backend/__tests__/hope-routes.test.ts apps/backend/__tests__/hope-jobs.test.ts apps/backend/__tests__/hope-consumer-contracts.test.ts packages/hope/__tests__/j2051-and-sfv.test.ts apps/backend/__tests__/read-audit-coverage.test.ts`
- `bun run test apps/web/src/modules/10-hope/__tests__/admission-hope-overview.dom.test.tsx apps/web/src/modules/10-hope/__tests__/hope-capture-workspace.dom.test.tsx apps/web/src/modules/06-admission/__tests__/admission-detail.dom.test.tsx`
- `bun run arch:abac-predicates`
- `bun run build:app` from `apps/web`
- targeted Biome check over Phase 2 backend/frontend files and generated client schema

Failed with pre-existing unrelated architecture issues:

- `bun run arch:boundaries` still reports 14 existing frontend boundary violations from M6/M15/M23/M24 screens importing `apps/web/src/shared/entity-lookups.tsx`. No new M10 boundary violation was reported.

Not run after the user's OpenAPI instruction:

- `openapi:emit`
- `openapi:check`
- `client:check`
- full `arch:fitness`, because it includes OpenAPI-related gates

Notes:

- `openapi:emit` and `client:gen` were run before the later "do not read/touch openapi.json" instruction. They passed at that time. After the instruction, `docs/api/openapi.json` was not read or modified again.
- No live DB suite was run because this environment did not expose `WARDENX_TEST_DATABASE_URL`.
- No Playwright E2E was added or run in this pass; the covered workflow is currently proven through backend route tests and jsdom route/navigation/capture tests.

## N. Deferred Phase 3 Work

Deferred intentionally to Phase 3:

- M36 due-soon notifications
- M36 overdue notifications
- email/SMS/push alert delivery
- notification-center redesign
- alert preferences and cadence
- persistent escalation routing
- global HOPE navigation notification badges

