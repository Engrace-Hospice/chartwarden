# WardenX HOPE Phase 3 Alerts, Escalations & Workflow Hardening Report

Date: 2026-08-29

## A. Existing Phase 2 Surface Reused

Phase 3 extends the Phase 2 admission-scoped workflow instead of adding a competing dashboard:

- `/admissions/:admissionId/hope`
- `/admissions/:admissionId/hope/timepoints/:kind`
- `/admissions/:admissionId/hope/sfv/:sfvId`
- `admission-hope-overview.tsx`
- `hope-capture-workspace.tsx`
- Admission Detail compact HOPE panel

The top-level legacy M10 surfaces remain present: `/hope`, `/patients/:patientId/hope`, `/hope/sfv`,
`/hope/assessments/:id`, `/hope/submissions`, `/hope/submissions/:id`, and `/hope/compliance`.

## B. Files Changed In Phase 3

- `packages/hope/src/attention.ts`
- `packages/hope/src/index.ts`
- `packages/hope/__tests__/attention.test.ts`
- `apps/backend/src/modules/10-hope/routes/service.ts`
- `apps/backend/src/modules/10-hope/routes/hope-typebox.ts`
- `apps/backend/src/modules/10-hope/jobs/index.ts`
- `apps/backend/src/modules/10-hope/jobs/cron-store.ts`
- `apps/backend/src/modules/10-hope/jobs/cron-workers.ts`
- `apps/backend/src/modules/10-hope/index.ts`
- `apps/backend/src/modules/10-hope/outbox-consumers/m6-admission-workflow.ts`
- `apps/backend/src/modules/36-messaging/alert-emitter-drizzle.ts`
- `apps/backend/src/index.ts`
- `apps/backend/__tests__/hope-jobs.test.ts`
- `apps/backend/__tests__/hope-routes.test.ts`
- `apps/backend/__tests__/hope-consumer-contracts.test.ts`
- `apps/backend/__tests__/gap-096-alert-emitter-live.test.ts`
- `apps/backend/__tests__/messaging-routes.test.ts`
- `apps/web/src/modules/10-hope/hope-status.ts`
- `apps/web/src/modules/10-hope/admission-hope-overview.tsx`
- `apps/web/src/modules/10-hope/__tests__/admission-hope-overview.dom.test.tsx`
- `apps/web/src/modules/06-admission/admission-detail.tsx`
- `apps/web/src/modules/06-admission/__tests__/admission-detail.dom.test.tsx`
- `packages/messaging/src/seed/alert-rules.ts`
- `packages/messaging/__tests__/alert-rules-seed.test.ts`
- `packages/messaging/__tests__/fan-out.test.ts`
- `packages/messaging/__tests__/workflow-acceptance.test.ts`
- `packages/db/src/schema/messaging/alerts.ts`
- `packages/db/src/schema/messaging/alert-rules.ts`
- `packages/db/migrations/0216_m36_alert_correlation_dedup.sql`
- `packages/types/src/admission.ts`
- `e2e/specs/hope-attention.spec.ts`
- `docs/cartography/hope_report.md`

`docs/api/openapi.json` was not read or modified during Phase 3.

## C. Attention Read Model

The existing `GET /api/v1/admissions/:admissionId/hope` response is extended in place. Fixed timepoints
keep their workflow status:

```ts
workflow_not_initialized | not_applicable | upcoming | open | late | completed | expired | skipped
```

Each fixed timepoint and SFV now also carries:

```ts
attention: {
  state:
    | "none"
    | "upcoming"
    | "due_soon"
    | "due"
    | "overdue"
    | "window_expired"
    | "missed"
    | "workflow_issue",
  severity: "none" | "info" | "warn" | "critical",
  action:
    | "COMPLETE_ADMISSION_RFA"
    | "COMPLETE_HUV1"
    | "COMPLETE_HUV2"
    | "COMPLETE_DISCHARGE_RFA"
    | "OPEN_SFV"
    | "REPAIR_WORKFLOW"
    | "NONE",
  message: string | null,
  deadline: string | null
}
```

`summary` now includes the Phase 2 counters plus `highestSeverity`, `dueSoonCount`, and
`workflowIssueCount`. `workflow_not_initialized` maps to `workflow_issue`, not overdue. `late` maps to
overdue attention while still preserving `workflowStatus = late`. `expired` maps to `window_expired`, not
SFV `missed`.

## D. Alert And Escalation Flow

The existing M10 watchdogs are extended rather than adding a new cron:

```text
hope-window-watchdog
  -> m10.hope.timepoint_expired
  -> AlertEmitter.emit(... attentionState: "window_expired")

sfv-watchdog
  -> m10.hope.sfv_overdue / m10.hope.sfv_missed
  -> AlertEmitter.emit(... attentionState: "overdue" | "missed")
```

M10 talks only to the public `AlertEmitter` seam injected at boot. M10 does not import M36 internals.
M36 platform rules now include `m10.hope.sfv_created`, `m10.hope.sfv_overdue`,
`m10.hope.sfv_missed`, and `m10.hope.timepoint_expired`.

## E. Durable Idempotency

M36 alert persistence now treats `(organization_id, correlation_id)` as the durable deduplication key.
The new migration adds:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "alert_org_correlation_unique"
  ON "alert" ("organization_id", "correlation_id");
```

`createDrizzleAlertEmitter(...).persist()` returns the existing alert for repeated correlation ids and does
not create duplicate `notification_delivery` rows.

## F. UI Changes

Admission Detail’s compact HOPE panel now displays attention summaries such as workflow issues, overdue or
missed work, due-soon work, and action-required counts. The HOPE overview shows attention badges and messages
on fixed cards and SFV rows while still displaying the backend workflow status/date fields.

React formats dates and routes contextual CTAs only. It does not calculate HUV windows, SFV triggers,
late/expired state, or M9 assessment timing.

## G. M9 Integration Audit

M9 was audited before adding M9 alerts. The current M9 code exposes assessment record/correction,
significant-change, license, and reassessment-cadence logic, but no authoritative public 48-hour Clinical
Admission Assessment due/due-soon/overdue read model was found. Phase 3 therefore does not add M9 clinical
admission assessment alerts; doing so in M10 or React would recreate forbidden timing logic outside M9.

The UI copy remains explicit:

- `Clinical Admission Assessment` for M9
- `HOPE Admission Assessment` for M10

## H. Historical Admissions

Historical admissions with missing M10 schedules remain `workflow_not_initialized`. The UI presents this as a
workflow data issue, not clinician-overdue work, and `summary.workflowIssueCount` is separate from
`summary.overdueCount`. No React-side repair/backfill was added.

## I. Tests

Added/updated coverage:

- `packages/hope/__tests__/attention.test.ts`: fixed-timepoint and SFV attention mappings.
- `apps/backend/__tests__/hope-routes.test.ts`: summary endpoint includes attention and separates workflow
  issues from overdue/missed counts.
- `apps/backend/__tests__/hope-jobs.test.ts`: watchdog transition events plan M36 alert emissions with stable
  correlation ids.
- `packages/messaging/__tests__/alert-rules-seed.test.ts`: HOPE M10 event names are seeded in M36 rules.
- `apps/backend/__tests__/gap-096-alert-emitter-live.test.ts`: live conditional proof that M36 dedupes by
  correlation id.
- `apps/web/src/modules/10-hope/__tests__/admission-hope-overview.dom.test.tsx`: overview renders attention,
  workflow issues, SFVs, and contextual CTAs.
- `apps/web/src/modules/06-admission/__tests__/admission-detail.dom.test.tsx`: compact Admission HOPE panel
  surfaces attention without merging M9 and M10.
- `e2e/specs/hope-attention.spec.ts`: Playwright scenario for seeded HOPE attention and contextual SFV flow.

## J. Verification

Passed:

- `bun run typecheck`
- `bun run build`
- `bunx vitest run packages/hope/__tests__/attention.test.ts apps/backend/__tests__/hope-jobs.test.ts packages/messaging/__tests__/alert-rules-seed.test.ts packages/messaging/__tests__/fan-out.test.ts packages/messaging/__tests__/workflow-acceptance.test.ts apps/backend/__tests__/messaging-routes.test.ts apps/backend/__tests__/hope-routes.test.ts apps/web/src/modules/10-hope/__tests__/admission-hope-overview.dom.test.tsx apps/web/src/modules/06-admission/__tests__/admission-detail.dom.test.tsx`
- `bunx vitest run apps/backend/__tests__/hope-consumer-contracts.test.ts apps/backend/__tests__/hope-jobs.test.ts apps/backend/__tests__/hope-routes.test.ts`
- targeted `bunx biome check` over the changed Phase 3 files
- `bun run arch:abac-predicates`
- `bun run arch:tables`
- `bun run arch:ddl`
- `bun run arch:live-suites`

Failed with pre-existing unrelated frontend boundary violations:

- `bun run arch:boundaries` reports the known M6/M15/M23/M24 imports of
  `apps/web/src/shared/entity-lookups.tsx`. No M10 boundary violation remains.

Not executed:

- Live DB/RLS suites: `WARDENX_TEST_DATABASE_URL` is not set in this environment.
- Playwright E2E: `localhost:5173` is not reachable; the new spec is present but the local stack is not
  running.
- OpenAPI gates: not run because the user explicitly instructed not to read or touch
  `docs/api/openapi.json`.

## K. Deferred Phase 3 Work

- Authoritative M9 Clinical Admission Assessment alerting, pending an M9-owned 48-hour compliance read model.
- Tenant-specific HOPE due-soon policy configuration beyond the central default evaluator.
- Historical-admission reconciliation/backfill job for `workflow_not_initialized` records.
- Full notification-center UX expansion beyond existing M36 rule/fan-out integration.
- Production execution of live DB/RLS and Playwright suites once the required environment is available.

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
