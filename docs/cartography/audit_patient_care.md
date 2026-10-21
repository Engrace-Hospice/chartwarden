# ChartWarden M7 Patient Care Plan Audit

Date: 2026-08-29

Scope: actual running repository implementation of Module 7 Patient Care Plan, including backend, schema, migrations, frontend, tests, and cross-module wiring with M6, M8, M9/M10, M11, M14, M15, M17, and M30.

Bottom line: ChartWarden does not currently support a real interdisciplinary Patient Care Plan workflow end-to-end. M7 has substantial production data structures, routes, route service logic, RLS/audit coverage, a quorum engine, manual bootstrap, authoring APIs, and a live M14 IDG consumer. The workflow breaks because admission activation does not create the care plan in production, the frontend is read-only, the terminal-problem activation guard is not enforced by the production signing path, discharge does not close M7, IDG decisions silently mutate active plan elements before signature, and signed versions do not preserve immutable clinical content snapshots.

## A. What exists today

Genuinely usable production functionality:

- Backend module: `apps/backend/src/modules/07-care-plan` is implemented with route registration, a Drizzle route service, lifecycle/domain helpers, seams, an M14 outbox consumer, cron workers, events, ABAC predicates, and erasure support.
- Domain/type package: M7 contracts live primarily in `packages/types/src/care-plan.ts`. There is no separate `packages/*care-plan*` domain package beyond this leaf contract surface and backend lifecycle helpers.
- DB tables: M7 owns `care_plan`, `care_plan_version`, `care_plan_signature`, `problem`, `goal`, `intervention`, and `care_plan_idg_decision_application`.
- Manual care-plan bootstrap API: `POST /api/v1/patients/:patientId/care-plan` creates a care-plan root and an initial draft version.
- Read API: `GET /api/v1/patients/:patientId/care-plan` returns a coherent aggregate with root, active version, versions, problems, goals, interventions, and signatures.
- Version APIs: create version, list versions, get one version, finalize draft to `in_review`, sign an `in_review` version, and return an `in_review` version to draft.
- Element APIs: create/update/resolve problems; create/update goals; create/update/discontinue interventions.
- Signer quorum: server-side matching exists. Initial, interim revision, and discharge versions require RN case manager plus hospice physician or NP. IDG review requires RN case manager, MSW, chaplain, and hospice physician or medical director.
- Current version selection: root table stores `active_version_id`.
- M14 IDG incoming consumer: `idg.decision_recorded` is live-bound in `apps/backend/src/index.ts` through `buildM7IdgDecisionConsumer`.
- Review clock cron: M7 has cron jobs that scan for initial overdue, review due, and review overdue conditions and emit M7 events.
- Cross-module seam: `CarePlanReader` is implemented and consumed by M8/M14/M15 style integrations for read-only or validation use.
- RLS/audit: M7 tables have RLS, write-audit triggers, PHI redaction denylists, and route read-audit declarations.
- Frontend read screens: the web app can show a care-plan view, version history, and patient-friendly summary for an already-created plan.

## B. What is partially wired

- Admission bootstrap: `bootstrapCarePlan` exists and creates root plus initial draft, but it is only exposed by the manual patient route. M6 declares and publishes `m6.admission.activated` with M7 as a declared consumer, but no M7 activation consumer is implemented or registered live.
- Admission discharge closure: M6 publishes `m6.admission.discharged`, but M7 is not a declared consumer of that event and no M7 discharge consumer or production discharge route exists.
- Version lifecycle: the production service supports draft, in-review, signed, and root activation, but does not use the richer pure lifecycle machine consistently and does not mark old signed versions superseded.
- Historical snapshots: `care_plan_version.state_snapshot` exists and is PHI-redacted in audit, but production finalize/sign does not populate it.
- Terminal problem guard: implemented in pure lifecycle validation, but not enforced by the production finalize/sign path.
- IDG integration: live-bound and mutates M7 data, but it creates or reuses a draft `idg_review` version while immediately changing global active plan elements before that version is signed.
- M8 encounter linkage: schema and routes for encounter care-plan links exist, but the implementation is very thin and does not update M7 progress, goals, interventions, or evidence.
- M11 orders: `intervention.linked_order_id` exists and M11 can read it, but no M7 route populates it and no automatic intervention-to-order flow was found.
- M17 scheduling: scheduling frequency/proposal code references care-plan intent conceptually, but no live M7-to-M17 seam/event creates visits or proposals.
- M30 quality: care-plan 15-day adherence is measured from M7 read data, but M7 does not expose a complete operational review workflow.
- Frontend signatures: version history attempts to show signer requirements/signatures, but it is read-only and likely mishandles `requiredSignerSet` as strings when the API returns `{ role, count }` objects.

## C. What is scaffold/mock/spec only

- Automatic `m6.admission.activated -> M7 bootstrap`.
- Automatic `m6.admission.discharged -> M7 discharged`.
- A complete `new version -> snapshot -> signatures -> publish immutable version` clinical record workflow.
- Frontend authoring for problems, goals, interventions, revisions, finalization, signing, or discharge.
- Automatic assessment-to-care-plan suggestions or mutations.
- Automatic encounter progress updates, goal resolution, or evidence attachment into M7.
- Automatic intervention-to-order creation.
- Automatic intervention-to-visit scheduling.
- A clinician-confirmed IDG proposal workflow. The pure IDG decision planner points in that direction, but production mutates active rows immediately.
- Overdue goal/intervention modeling.
- A visible operational attention center for missing signatures, missing terminal problem, review due, IDG review due, or unapplied IDG decisions.

## D. What is missing

- Live M6 activation consumer in M7.
- Live M6 discharge/revocation/transfer closure behavior in M7.
- Production discharge route or discharge version workflow.
- Enforced terminal active problem guard in production version activation.
- One-open-revision guard.
- Immutable signed-version content snapshots.
- Superseding of old signed versions.
- Step-up/session freshness enforcement for care-plan signatures.
- Populated signer membership/actor identity in production signatures.
- UI write workflow for the interdisciplinary plan.
- UI readiness/missing-signature evaluator.
- UI display of next review due, initial overdue, review overdue, goal overdue, intervention overdue, or incomplete-plan states.
- Full E2E covering admission to plan creation, authoring, signatures, IDG revision, and discharge.

## E. Current user journey

What a real user can do today from the UI:

1. Open `/patients/:patientId/care-plan`.
2. If a care plan has already been created by API/seed/manual backend call, view root status, active version summary, problems, goals, and interventions.
3. Navigate to `/care-plans/:planId/versions` to view version rows and partial signer information.
4. Navigate to `/care-plans/:planId/summary` to view a read-only patient/family-oriented summary.

What a real user cannot complete from the UI:

- The user cannot bootstrap the plan.
- The user cannot create the initial version from admission activation.
- The user cannot add a terminal problem.
- The user cannot add goals or interventions.
- The user cannot finalize a version for signature.
- The user cannot sign.
- The user cannot publish/activate.
- The user cannot create or review an IDG revision.
- The user cannot discharge the care plan.

API-only journey that works today:

1. Manually call `POST /api/v1/patients/:patientId/care-plan`.
2. Add problems/goals/interventions through M7 APIs.
3. Create/finalize/sign versions through M7 APIs.
4. A version can become signed and root can become active when quorum is met.

Even this API journey is clinically incomplete because production signing does not enforce the terminal problem guard, does not snapshot signed content, and allows active plan elements to keep changing outside immutable version history.

## F. Current data model

Text diagram:

```text
M6 Admission
  soft ref by care_plan.admission_id
  no DB foreign key
  no live M6 -> M7 bootstrap consumer

care_plan
  id
  organization_id
  provider_entity_id?
  location_id?
  patient_id
  admission_id
  status: draft | active | discharged
  version
  initial_due_at
  initial_signed_at?
  next_review_due_at?
  admission_activated_at?
  initial_warning_emitted
  review_due_emitted
  review_overdue_emitted
  active_version_id?
  created_at / updated_at

  -> care_plan_version[]
       id
       care_plan_id
       sequence
       status: draft | in_review | signed | superseded
       kind: initial | idg_review | interim_revision | discharge
       idg_meeting_id?
       state_snapshot?
       required_signer_set
       patient_understanding_text?
       drafted_at / signed_at? / superseded_at?
       drafted_by_membership_id?

       -> care_plan_signature[]
            id
            care_plan_version_id
            membership_id?
            signer_role
            signed_at
            signature_method
            invalidated_at?

  -> problem[]
       plan-scoped global mutable problem rows

  -> goal[]
       plan-scoped global mutable goal rows
       problem_id -> problem.id

  -> intervention[]
       plan-scoped global mutable intervention rows
       problem_id -> problem.id
       goal_id? -> goal.id
       linked_order_id? soft ref to M11

care_plan_idg_decision_application
  idempotency marker for M14 idg.decision_recorded deliveries
```

Important constraints:

- `care_plan_one_per_admission_uq` enforces at most one non-discharged care plan per `(organization_id, admission_id)`.
- `care_plan_version` has unique `(care_plan_id, sequence)`.
- There is no DB unique constraint for one draft/in-review version per plan.
- `care_plan.active_version_id` is a soft UUID reference, not a declared FK in the current schema.
- Elements are attached to the root plan, not to a specific immutable version.

## G. Care Plan state machines

Root lifecycle in pure domain:

```text
draft --activate(hasTerminalActiveProblem)--> active
active --reviseSigned--> active
draft|active --discharge(reason)--> discharged
```

Production root behavior:

- Manual bootstrap creates `draft`.
- Signing a version with quorum sets root `status = active`, sets `active_version_id`, sets `initial_signed_at` for initial versions, and calculates `next_review_due_at`.
- No production discharge transition was found.

Version lifecycle in pure domain:

```text
draft --routeForSigning--> in_review
in_review --recordSignature(quorum not met)--> in_review
in_review --recordSignature(quorum met)--> signed
in_review --returnForEdits--> draft
signed --supersede--> superseded
```

Production version behavior:

- `createVersion` inserts `draft`.
- `finalizeVersion` moves `draft -> in_review`.
- `signVersion` records signatures and moves `in_review -> signed` when quorum is met.
- `returnVersionToDraft` moves `in_review -> draft` and invalidates signatures.
- No production code found that supersedes previous signed versions.

Problem states:

```text
active | resolved | inactive
```

Pure lifecycle supports `active -> resolved` and `active -> inactive`. Production APIs can resolve and patch, but patching does not enforce the pure transition graph.

Goal states:

```text
not_started | in_progress | met | not_met | revised | discontinued
```

Production patch can set status but does not enforce the pure graph or event-driven completion.

Intervention states:

```text
active | discontinued | completed
```

Production supports create/update/discontinue. No completion route was found.

## H. M6 Admission wiring

Explicit answers:

- M6 publishes `m6.admission.activated`: yes. The event schema includes `admissionId`, `patientId`, `activatedAt`, and optional `currentElectionPeriodId`. M7 is listed as a declared consumer.
- M7 declares/implements a live activation consumer: no implementation or binding was found.
- M7 bootstrap registered in production: no.
- Activation creates M7 care-plan root: no, not through production event dispatch.
- Activation creates initial version: no, not through production event dispatch.
- Activation creates default clinical content: no.
- Repeated manual bootstrap is idempotent-ish: yes. The route service looks for an existing non-discharged plan for the admission and the DB partial unique index backs this up.

Discharge:

- M6 publishes `m6.admission.discharged` with `admissionId`, `reason`, and `dischargeDate`.
- M7 is not listed as a declared consumer of that discharge event in the M6 catalog.
- No M7 discharge consumer is live-bound.
- No automatic M7 root transition to `discharged` happens.
- No explicit discharge version is created.
- Open problems/goals/interventions are left as-is.

Hold/resume/transfer/revocation:

- M6 has on-hold/resumed events; M7 has no consumers.
- Revocation/transfer are represented in M6 discharge flows, but because M7 has no discharge consumer, they have no M7 effect.

## I. Versioning model

Supported version kinds:

```text
initial
idg_review
interim_revision
discharge
```

Relationship:

- One root `care_plan` has many `care_plan_version` rows.
- Root `active_version_id` selects the current active/signed version.
- Version `sequence` is incremented per plan.
- Version `required_signer_set` is captured as JSON at finalize/in-review.

Semantics actually enforced:

- Draft versions can be edited in the sense that global plan elements can be edited while versions exist.
- A draft version can move to `in_review`.
- An in-review version can gather signatures.
- When quorum is met, the version becomes `signed` and root points `active_version_id` to it.
- A new draft can exist while another signed version is active.
- Multiple drafts/revisions can exist because there is no one-open-revision guard.

Semantics not enforced:

- Previous signed versions are not marked `superseded`.
- Signed versions do not preserve immutable state snapshots.
- There is no production cancellation/void flow.
- There is no production discharge-version publishing flow.
- Element history is not version-scoped.

## J. Problems / Goals / Interventions

Problems:

- Table: `problem`.
- Scope: `care_plan_id`, organization, optional provider entity/location.
- Fields include description, status, kind, source, ICD-10/SNOMED/code support, onset/resolved timestamps, resolution note, SUD flag, timestamps, and optimistic version.
- Kind supports terminal vs related vs unrelated.
- Status supports active, resolved, inactive.
- Problems are structured clinical entities with coded support and free-text description, not free text only.
- Assignment/discipline ownership is not the primary problem model.
- Resolving a problem does not automatically resolve linked goals/interventions in production.

Goals:

- Table: `goal`.
- Linked to problem by `problem_id`.
- Fields include original text, revised text, measurable outcome, source, status, status note, target date, consent id for agent-stated attribution, timestamps, and optimistic version.
- Operational usability is partial: goals have target/outcome/status, but no progress ledger, no automated completion, and no overdue business concept surfaced by M7.

Interventions:

- Table: `intervention`.
- Linked to problem and optionally goal.
- Fields include discipline, scope text, frequency text, status, discontinue reason, linked order id, timestamps, and optimistic version.
- Interventions are planning instructions/intent. They are not executable orders and do not automatically create scheduled visits.
- `linked_order_id` exists, but no M7 write route populates it and no automatic order creation was found.

## K. Signature & quorum engine

Required signer sets:

```text
initial
interim_revision
discharge
  - hospice_physician OR nurse_practitioner: 1
  - rn_case_manager: 1

idg_review
  - rn_case_manager: 1
  - msw: 1
  - chaplain: 1
  - hospice_physician OR medical_director: 1
```

Server behavior:

- `resolveRequiredSignerSet(kind)` maps `idg_review` to the IDG set and all other kinds to the initial set.
- The matching algorithm is consume-once: a single signature cannot satisfy multiple slots.
- A signer role that matches no remaining slot is rejected.
- Duplicate/unneeded signer roles are rejected.
- Partial signatures are stored while version remains `in_review`.
- When all slots are met, the version becomes `signed`.

Gaps:

- Signature route requires `care_plan.sign`, `caseload_or_scope`, and `signer_role_match`, but no direct step-up/session freshness check was found in the route.
- Production signatures store nullable `membership_id`; the route service does not thread the acting membership into the persisted signature.
- `patientUnderstandingText` exists in the API schema/DB but is not persisted by the production sign service.
- Frontend cannot sign or show a robust missing-signature checklist.

## L. M14 IDG integration

Live incoming event:

```text
M14 idg.decision_recorded -> M7 buildM7IdgDecisionConsumer -> live bound in apps/backend/src/index.ts
```

Consumer behavior:

- Handles only payloads with schema version `2026-01-v1`, kind `care_plan_update`, and non-empty mutations.
- Requires an active M7 plan for the patient. If none exists, the consumer throws and the event is retried/DLQ'd rather than creating a plan.
- Reuses an existing draft `idg_review` version for the same meeting or creates a new draft `idg_review` version.
- Inserts an idempotency row in `care_plan_idg_decision_application`.
- Applies mutations directly to global `problem`, `goal`, and `intervention` rows.

Exact decision behavior:

```text
IDG decision -> creates/reuses draft idg_review version -> immediately mutates active plan element rows
```

It does not behave as:

```text
IDG decision -> proposal -> clinician/team signs -> new current version changes active content
```

Clinical/governance implication: IDG decisions currently change active care-plan content before the IDG review version is signed. This bypasses the expected signature/publish gate for clinical plan changes.

## M. Assessment/Encounter integrations

Assessments M9/M10:

- M9 declares M7 as a consumer for assessment events such as assessment recorded and significant change.
- No M7 consumer implementation or live binding for M9/M10 assessment events was found.
- Assessment findings do not create problems, suggest problems, update goals, update interventions, or trigger a care-plan review in M7 production code.

Encounters M8:

- M8 has care-plan link concepts and can use M7 read seams for relevance.
- No signed-encounter-to-M7 consumer was found.
- Signed encounters do not update progress, resolve goals, create review suggestions, or attach evidence to M7 in a meaningful production workflow.

Classification:

- Assessment integration: declared/spec only for M7 mutation.
- Encounter integration: read-only/partial linkage.
- No assessment or encounter flow was found that silently mutates M7 active content.

## N. M15 boundary

M7 is the interdisciplinary patient care plan. M15 owns discipline-specific care plans such as aide POC, MSW plan, spiritual plan, and volunteer plan.

Actual M7/M15 behavior:

- M15 reads M7 through `CarePlanReader`.
- M15 validates discipline-plan parent references against active M7 problems/goals/interventions.
- M15 maps discipline plan kinds to M7 lenses: aide to CHHA, MSW to MSW, spiritual to chaplain, volunteer to volunteer.
- M15 bootstrap depends on M6 admission activation, not M7 bootstrap.
- M7 does not consume M15 events.
- M7 does not display M15 plan status.
- M7 does not synchronize M15 content.

Boundary assessment:

- The ownership boundary is mostly respected: M7 owns interdisciplinary problems/goals/interventions; M15 refines or links discipline-specific content.
- The risk is workflow sequencing: M15 can require active M7 elements, while M7 is not automatically bootstrapped from admission and not writable in the UI.

## O. Care Plan review cadence

Implemented:

- Root stores `initial_due_at`, `initial_signed_at`, `next_review_due_at`, `admission_activated_at`, and emitted-marker booleans.
- M7 cron scans can emit:
  - `m7.care_plan.initial_overdue`
  - `m7.care_plan.review_due`
  - `m7.care_plan.review_overdue`
- M7 read seam supports 15-day cycle counts for quality/reporting.
- There is an overdue-status route, but it calls the seam by patient id and is not used by the M7 frontend.

Missing:

- No full M7 review workflow.
- No UI review due/overdue display.
- No automatic creation of IDG review versions from cadence.
- No alert inbox implementation inside M7.
- No modeled overdue states for goals or interventions.

Conclusion: there is a persisted and job-driven review clock, but not a complete operational 15-day care-plan review cadence in M7.

## P. Alerts / attention

Implemented or partial:

- Initial overdue: event/job support exists.
- Review due: event/job support exists.
- Review overdue: event/job support exists.
- Missing signatures: derivable from version required signer set and signatures, but no dedicated readiness/attention endpoint and weak frontend display.

Missing:

- Missing terminal problem attention.
- IDG review due UI.
- Goal overdue.
- Intervention overdue.
- Unapplied IDG decision queue. IDG decisions are applied immediately or fail at dispatcher level.
- Care-plan incomplete alert in the M7 UI.
- Signature-required task workflow in the M7 UI.

## Q. Frontend

Screens:

```text
/patients/:patientId/care-plan
  file: apps/web/src/modules/07-care-plan/care-plan-view.tsx
  purpose: read current care-plan aggregate for a patient
  API: GET /api/v1/patients/:patientId/care-plan, GET /api/v1/patients/:patientId
  actions: navigate to history/summary
  capability: read-only

/care-plans/:planId/versions
  file: apps/web/src/modules/07-care-plan/version-history.tsx
  purpose: read version history and signature rows
  API: GET /api/v1/care-plans/:planId/versions
  actions: none that write
  capability: read-only

/care-plans/:planId/summary
  file: apps/web/src/modules/07-care-plan/summary.tsx
  purpose: patient/family-oriented summary
  API: GET /api/v1/care-plans/:planId/summary
  actions: none that write
  capability: read-only
```

User can currently:

- See current care plan if it exists.
- See version history.
- See problems/goals/interventions as human text.
- See summary.

User cannot currently:

- Create/bootstrap care plan.
- Create a revision.
- Create/edit problems.
- Create/edit goals.
- Create/edit interventions.
- Sign.
- See a complete missing-signature checklist.
- Activate/publish.
- Review IDG changes.
- Discharge the plan.

UX/data-shaping gaps:

- Version history shows roles/IDs more than useful signer names.
- Required signer set rendering appears mismatched with the API object shape.
- Empty-state copy says the initial IPOC is created when the patient is admitted, which is not true in live production wiring.
- No readiness blockers or review cadence are visible.

## R. Events / live consumers

M7 publishes:

```text
m7.care_plan.created
  when: manual bootstrap service creates root
  payload: planId, patientId, admissionId
  declared consumers: m33
  live consumers verified: none in this pass beyond catalog/reporting-style declarations

m7.care_plan.version_drafted
  when: create version or IDG consumer drafts idg_review
  payload: planId, versionId, kind, sequence
  declared consumers: m14, m33
  live consumers verified: M14 has subscription infrastructure for M7 events, but version_drafted specific live effect was not found

m7.care_plan.version_signed
  when: quorum reached
  payload: planId, versionId, kind, snapshotRef
  declared consumers: m8, m14, m22, m28, m30, m33
  live consumers verified: M14 auto-close subscription mapping; reporting catalog refresh mapping

m7.care_plan.review_due
  when: review clock due scan
  payload: planId, patientId, dueAt
  declared consumers: m36
  live consumers verified: event emission path exists; no M7 UI consumer

m7.care_plan.review_overdue
  when: review overdue scan
  payload: planId, patientId, dueAt, overdueAt
  declared consumers: m8, m33, m36
  live consumers verified: reporting catalog refresh mapping

m7.care_plan.initial_overdue
  when: initial plan overdue scan
  payload: planId, patientId, admissionActivatedAt
  declared consumers: m8, m33, m36
  live consumers verified: no direct M7 UI consumer

m7.care_plan.discharged
  when: pure lifecycle discharge
  payload: planId, patientId, reason
  declared consumers: m16, m30, m33
  live consumers verified: production M7 discharge emitter not found

m7.problem.added / updated / resolved
m7.goal.added / updated / met / discontinued
m7.intervention.added / updated / discontinued
  when: production element routes
  payload: planId, element id, status/source/discipline depending event
  declared consumers: m14/m28 and m11 for intervention events
  live consumers verified: no automatic M11 order or M17 scheduling effect found
```

M7 consumes:

```text
M14 idg.decision_recorded
  consumer: apps/backend/src/modules/07-care-plan/outbox-consumers/m14-idg-decision-recorded.ts
  binding: apps/backend/src/index.ts buildM7IdgDecisionConsumer
  effect: create/reuse draft idg_review version and immediately mutate plan elements
  status: implemented and live-bound

M6 m6.admission.activated
  consumer: none found
  binding: none found
  effect: none in production
  status: declared by M6 only

M6 m6.admission.discharged
  consumer: none found
  binding: none found
  effect: none in production
  status: missing

M9/M10 assessment events
  consumer: none found in M7
  effect: none
  status: declared/spec only

M8 encounter events
  consumer: none found in M7
  effect: none
  status: missing for mutation/progress

M15 discipline-plan events
  consumer: none found in M7
  effect: none
  status: no synchronization
```

## S. Tests

Existing M7 tests found:

```text
apps/backend/__tests__/care-plan-lifecycle.test.ts
  type: unit/domain
  covers: pure root/version/problem/goal/intervention lifecycle and quorum concepts

apps/backend/__tests__/care-plan-routes.test.ts
  type: route/injection
  covers: route registration/auth/read/write behavior through test service

apps/backend/__tests__/care-plan-authoring.test.ts
  type: unit/domain/service-ish
  covers: authoring rules and element behavior

apps/backend/__tests__/care-plan-seam.test.ts
  type: seam/unit
  covers: CarePlanReader style behavior

apps/backend/__tests__/care-plan-outbox-jobs.test.ts
  type: unit/job
  covers: review/overdue event planning

apps/backend/__tests__/care-plan-workflow-acceptance.test.ts
  type: backend workflow/unit acceptance
  covers: API-level intended lifecycle, not frontend E2E

apps/backend/__tests__/care-plan-idg-consumer.test.ts
  type: unit/consumer
  covers: IDG decision consumer/planner behavior

apps/backend/__tests__/m7-care-plan-read-service.live.test.ts
  type: live DB
  covers: production read service

apps/backend/__tests__/m7-care-plan-write.live.test.ts
  type: live DB
  covers: production write service paths

apps/backend/__tests__/care-plan-conformance.live.test.ts
  type: live DB/conformance
  covers: DB-backed conformance aspects

apps/backend/__tests__/care-plan-eraser.test.ts
  type: unit/eraser
  covers: M7 erasure

packages/db/migrations/__tests__/m7-rls-isolation.live.test.ts
  type: live DB/RLS
  covers: cross-tenant RLS isolation
```

Frontend:

- No `apps/web/src/modules/07-*/__tests__/*` tests were found.

E2E:

- No E2E was found proving `Admission activated -> Care Plan created -> terminal problem -> goals/interventions -> signatures -> active -> IDG revision -> discharge`.

Production-vs-test divergence:

- Pure lifecycle tests enforce terminal problem before activation; production signing does not.
- Pure/version comments imply snapshots; production does not populate snapshots.
- Tests cover manual/API bootstrap; production M6 event bootstrap is not bound.
- Pure IDG flow is closer to a draft/proposal model; live IDG consumer mutates global active elements immediately.
- Frontend only proves/read-renders screens, if anything; no full write workflow is present.

## T. Main business/architecture inconsistencies

1. Critical: `m6.admission.activated` does not create M7 in production. The care-plan root is not born from the admission lifecycle.
2. Critical: IDG decisions mutate active care-plan elements before signature. This undermines version governance.
3. Critical: signed versions do not snapshot clinical content. Historical care-plan versions are not reliable immutable clinical records.
4. High: production signing does not enforce the active terminal problem requirement.
5. High: no M6 discharge closure. Discharged/revoked/transferred admissions leave M7 plans open.
6. High: frontend is read-only, so users cannot complete the workflow without raw API/manual setup.
7. High: signatures lack persisted actor membership and direct step-up freshness enforcement in the route service.
8. Medium: multiple concurrent draft/in-review revisions can exist.
9. Medium: old signed versions are not marked superseded.
10. Medium: M11/M17 integration is planning-only or absent despite intervention fields/events implying downstream execution.
11. Medium: review cadence exists as clock/events, but not as a usable operational workflow.
12. Medium: M15 depends on M7 elements, but M7 is not guaranteed to exist or be authorable at the right time.

## U. Recommended target workflow

Do not implement in this audit. Recommended target based on existing architecture:

```text
M6 admission activated
  -> live M7 bootstrap consumer
  -> create one care_plan root per admission
  -> create initial draft version
  -> no default clinical content unless clinically justified

Clinician opens M7 UI
  -> add at least one active terminal problem
  -> add goals and interventions
  -> readiness endpoint shows blockers
  -> finalize version to in_review
  -> collect required signatures with step-up and actor membership
  -> quorum reached
  -> snapshot immutable content
  -> sign/publish version
  -> set root active_version_id and next_review_due_at

IDG decision recorded
  -> create/reuse idg_review draft proposal
  -> store proposed mutations without changing active content
  -> clinician reviews differences
  -> required IDG quorum signs
  -> publish applies mutations atomically and snapshots version

M6 discharge/revocation/transfer
  -> create discharge version or close root according to policy
  -> resolve/discontinue open elements only through explicit governed rules
  -> root transitions to discharged
```

This target preserves existing tables/routes where possible, but requires tightening the production service around version immutability and event-driven lifecycle wiring.

## V. Recommended implementation phases

Recommended: 3 phases.

Phase 1: make the backend lifecycle true.

- Bind M6 activation consumer to M7 bootstrap.
- Bind M6 discharge/revocation/transfer closure behavior.
- Enforce terminal active problem in production finalize/sign/publish.
- Add one-open-revision guard.
- Persist actor membership and step-up evidence for signatures.
- Populate signed version snapshots and mark old versions superseded.
- Add readiness endpoint.
- Add live tests for admission activation/discharge and no-terminal-problem rejection.

Phase 2: make IDG and review governance safe.

- Change IDG consumer from silent mutation to proposed mutation storage.
- Add publish/apply step for signed IDG review versions.
- Add review due/overdue operational state and UI/API visibility.
- Wire M14/M30/M36 consumers intentionally around review/signature states.
- Add tests for IDG proposal, partial signature, publish, supersede, and idempotent replay.

Phase 3: make the frontend and downstream integrations complete.

- Add UI authoring for problems/goals/interventions.
- Add version/revision workflow UI.
- Add signature UI with missing slots and signer names.
- Add review/discharge UI.
- Clarify M11 boundary: explicit order suggestion/order link flow, not automatic hidden order creation.
- Clarify M17 boundary: explicit visit proposal generation if desired.
- Add frontend and E2E tests for the full care-plan journey.

## W. Files likely to require modification

Backend M7:

```text
apps/backend/src/modules/07-care-plan/care-plan-route-service-db.ts
apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts
apps/backend/src/modules/07-care-plan/routes/care-plan-typebox.ts
apps/backend/src/modules/07-care-plan/lifecycle/care-plan.ts
apps/backend/src/modules/07-care-plan/lifecycle/elements.ts
apps/backend/src/modules/07-care-plan/lifecycle/required-signer-set.ts
apps/backend/src/modules/07-care-plan/outbox-consumers/m14-idg-decision-recorded.ts
apps/backend/src/modules/07-care-plan/consumers/apply-idg-decision.ts
apps/backend/src/modules/07-care-plan/seams/drizzle-store.ts
apps/backend/src/modules/07-care-plan/events-by-m7.ts
apps/backend/src/modules/07-care-plan/index.ts
apps/backend/src/index.ts
```

M6/M7 event wiring:

```text
apps/backend/src/modules/06-admission/events-by-m6.ts
apps/backend/src/modules/06-admission/routes/admission-route-service-db.ts
apps/backend/src/modules/07-care-plan/outbox-consumers/
```

DB/schema/migrations:

```text
packages/db/src/schema/care-plan/care-plans.ts
packages/db/src/schema/care-plan/care-plan-versions.ts
packages/db/src/schema/care-plan/care-plan-signatures.ts
packages/db/src/schema/care-plan/problems.ts
packages/db/src/schema/care-plan/goals.ts
packages/db/src/schema/care-plan/interventions.ts
packages/db/src/schema/care-plan/idg-decision-applications.ts
packages/db/migrations/0028_care_plan_m7_tables.sql
packages/db/migrations/0029_care_plan_m7_rls_audit_triggers.sql
packages/db/migrations/0127_care_plan_m7_write_lifecycle.sql
packages/db/migrations/0161_care_plan_gate_scan_markers.sql
packages/db/migrations/0163_care_plan_version_state_snapshot_redaction.sql
packages/db/migrations/0166_care_plan_idg_decision_application.sql
```

Types/seams:

```text
packages/types/src/care-plan.ts
packages/quality/src/seams/consumed/m7-care-plan.ts
packages/fhir/src/r4/mappers/care-plan.ts
```

Frontend:

```text
apps/web/src/modules/07-care-plan/screens.ts
apps/web/src/modules/07-care-plan/care-plan-view.tsx
apps/web/src/modules/07-care-plan/version-history.tsx
apps/web/src/modules/07-care-plan/summary.tsx
apps/web/src/modules/07-care-plan/care-plan-status.ts
```

Tests:

```text
apps/backend/__tests__/care-plan-lifecycle.test.ts
apps/backend/__tests__/care-plan-routes.test.ts
apps/backend/__tests__/care-plan-authoring.test.ts
apps/backend/__tests__/care-plan-seam.test.ts
apps/backend/__tests__/care-plan-outbox-jobs.test.ts
apps/backend/__tests__/care-plan-workflow-acceptance.test.ts
apps/backend/__tests__/care-plan-idg-consumer.test.ts
apps/backend/__tests__/m7-care-plan-read-service.live.test.ts
apps/backend/__tests__/m7-care-plan-write.live.test.ts
apps/backend/__tests__/care-plan-conformance.live.test.ts
packages/db/migrations/__tests__/m7-rls-isolation.live.test.ts
apps/web/src/modules/07-care-plan/__tests__/
e2e/
```

## Explicit answers to the important audit questions

1. Does `m6.admission.activated` currently create an M7 Care Plan in production?
   No.

2. Is the M7 bootstrap consumer actually registered live?
   No. Manual bootstrap route exists; live M6 activation consumer does not.

3. Does every Admission have at most one non-discharged Care Plan?
   If a care plan is created, yes, the DB enforces at most one non-discharged plan per `(organization_id, admission_id)`. But not every admission gets a plan automatically.

4. What exactly is required before an initial Care Plan becomes active?
   In production: an initial version must be finalized to `in_review` and receive the required signer quorum. In the pure domain: it also requires an active terminal problem. Production does not enforce that terminal-problem guard.

5. Is at least one active terminal problem really required?
   Domain-only, yes. Production route service, no.

6. Can a user complete the initial Care Plan from the frontend today?
   No.

7. Are problems, goals and interventions fully writable from UI?
   No. They are API-writable, not UI-writable.

8. Does M14 IDG create a new Care Plan version, or mutate the current one?
   It creates or reuses a draft `idg_review` version and also mutates current/global plan elements immediately.

9. Are IDG decisions automatically applied or clinician-confirmed?
   Automatically applied in production. No clinician-confirmed publish gate was found.

10. What signer quorum applies to each Care Plan version kind?
    `initial`, `interim_revision`, and `discharge`: hospice physician or NP plus RN case manager. `idg_review`: RN case manager, MSW, chaplain, and hospice physician or medical director.

11. Can the frontend show which signatures are still missing?
    Not reliably. Data exists server-side, but the frontend is read-only and appears to mismatch the required-signer-set object shape.

12. Is there a real 15-day Care Plan review cadence in M7?
    Partial. Dates, scans, and events exist; a complete user-facing review workflow does not.

13. Are overdue review/signature/goal/intervention states modeled?
    Review due/overdue is modeled through dates/events. Signature missing is derivable, not modeled as attention state. Goal/intervention overdue states are missing.

14. How does M7 interact with M15 discipline plans?
    M15 reads and validates against M7 active elements through `CarePlanReader`. M7 does not display, consume, or synchronize M15 plans.

15. Does M6 discharge automatically close/discharge M7?
    No.

16. Are signed/superseded versions immutable?
    No. Version rows become signed, but clinical elements are global mutable rows and production does not populate immutable snapshots or supersede old versions.

17. Can two concurrent revisions exist?
    Yes. No one-open-revision guard or DB partial unique constraint was found.

18. Is there an E2E proving Admission -> Care Plan -> revision -> discharge?
    No.
