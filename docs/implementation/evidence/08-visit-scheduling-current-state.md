# Workflow 08 — Visit Scheduling Current-State Evidence

**Audit date:** 2026-11-17
**Branch:** `feat/wf08-visit-scheduling`
**Commit:** `1199fd18ef03cd52f33fed8ccc60f1579845650d`
**Scope:** WP0 only. No application code, schema, API, event contract, or production configuration was
changed.

## Decision summary

Module 17 is implemented and mounted over the Drizzle/RLS service. Its server owns visit lifecycle,
credential, discipline, caseload/unassigned-pool, time-off, assignment, portal-grant, idempotency, audit,
and tenant controls. The redesign should reuse those controls and the current typed client; the browser
must not recreate eligibility or lifecycle rules.

Two historical concerns in the workflow proposal are no longer current defects:

- Visit creation and reassignment use `/api/v1/scheduling/eligible-clinicians`; calendar and detail views
  use the minimal `/api/v1/scheduling/staff` directory. They do not depend on the membership-management
  roster (`scheduling-workflow.tsx:270-286,595-608`, `calendar-page.tsx`, and
  `scheduling-routes.ts:379-391`). Comments in `screens.ts:38-50` and `e2e/specs/scheduling.spec.ts:30-51`
  are stale and should be retired.
- PostgreSQL `23P01` from a `visit*_no_overlap` exclusion constraint is classified as
  `CLINICIAN_SCHEDULE_CONFLICT` and mapped to HTTP 409, with actionable client copy
  (`packages/db/src/business-rules.ts:79-120`, `bootstrap/plugins/error-handler.ts:119-140`,
  `scheduling-errors.ts:16-39`). The classifier unit test passed. A concurrent live-DB reproduction was
  not run and therefore is not claimed as live proof.

The present UI is nevertheless not the target workflow:

- `/calendar` has day/week/month/list views and useful visit preview, but its staff/type/location/status
  filters are component state rather than URL state (`calendar-page.tsx:213-217,426-438`). There is no
  consolidated Calendar / Needs scheduling / My Visits / Staff & Availability workspace.
- The create form is one modal rather than a staged flow. It uses authoritative eligibility, but uses the
  browser's local `datetime-local` conversion without displaying the organization timezone or explaining
  DST ambiguity (`scheduling-workflow.tsx`).
- The request schema and UI accept `schedulerInternalNotes` and `caregiverReminderOptIn`, and the visit
  table owns both fields, but the route-to-service mapping drops them
  (`scheduling-typebox.ts:168-180`, `scheduling-workflow.tsx:324-337`,
  `scheduling-routes.ts:346-373`, `routes/service.ts:158-168`, `visits.ts:93,112`). This is a
  contract-preserving backend defect, not a reason to add another client workaround.
- Proposal rows omit the source and suggested discipline/member, show a patient UUID fragment instead of
  a name, and use a fixed dismissal reason. Publish requires an existing suggested membership and creates a
  fixed 13:00–14:00 UTC visit (`proposals.tsx:22-33,67-74,129-177`,
  `scheduling-route-service-db.ts:1458-1564`). It is not yet a scheduler triage form.
- Recurring and time-off screens expose raw membership identifiers and fixed-action flows. Recurring create
  and availability edit APIs exist but are not surfaced (`recurring.tsx`, `time-off.tsx`,
  `scheduling-routes.ts:550-719`).
- Visit detail shows current facts and linked encounter, but the immutable `visit_state_history` has no
  reviewed public read route. The UI's progress display is derived from current status, not durable history.
- `/calendar` has no `requiredPermission` in the screen registry while every backend read is protected
  (`screens.ts:107-112`). Route visibility must be reconciled with the shell contract; adding client-side
  hiding would remain presentation only, never authorization.

**Recommendation:** approve only a staged implementation. WP1 may consolidate navigation and responsive
presentation without changing clinical state. Before claiming a complete create/proposal workflow, approve
the contract-preserving request-field correction and decide the proposal triage contract. A history API,
proposal scheduling inputs, or schema changes require separate approval. No WP1–WP6 code should begin until
this report is approved.

## 1. Baseline, authority, and runtime status

- Working tree was dirty before WP0 with untracked workflow documents, local agent skills, and tool
  directories. They were preserved. This evidence file is the only WP0 write.
- Package manager/runtime: Bun 1.4.4 and Node 25.8.0. Repository commands include `bun run typecheck`,
  `bun run arch:fitness`, `bun run test`, `bun run test:e2e`, and `bun run check:boot:platform`
  (`package.json:80-84,517,525,693`).
- M17 routes are mounted over the live Drizzle service at `apps/backend/src/index.ts:6706`; its seams are
  registered at `index.ts:2740-2752`, and its workers/consumers are also composed from the application root.
  A barrel export alone is not being mistaken for boot wiring.
- Module ownership and dependencies remain governed by `architecture/module-manifest.ts` and its CJS
  mirror. No manifest or migration changed in WP0.
- Applicable accepted decisions include ADR-0010 (tenant isolation/RLS), ADR-0021 (route/idempotency
  conventions), ADR-0022 (DDL legality), ADR-0023 (cross-module seams), ADR-0030 (frontend module
  ownership), ADR-0032 (typed API transport), ADR-0036 (no assumed realtime backbone), ADR-0039 (pure
  state machines), ADR-0040 (HTTP hardening), and ADR-0090 (org-wide administrator scope). Architecture
  remains authoritative over the M17 module and screen proposals.
- No M17 scheduling rollout flag was found. Screens are registered directly. A rollback flag would be a
  new decision; rollback should initially mean reverting frontend composition while keeping compatible
  existing routes.

### Verification executed in WP0

The following affected non-live suites passed: visit machine, proposals, recurrence, time-off machine,
business-rule classification, caseload scope, own-vs-any authorization, workflow acceptance, calendar URL,
client error mapping, visit workflow DOM, scheduling writes DOM, and credential DOM.

```text
13 test files passed
151 tests passed
Duration: 3.27 s
```

The run emitted only the expected test-environment warning about a missing Better Auth secret.

Live suites were **not run**. The local database was unavailable (`ECONNREFUSED`), the existing backend on
port 3000 returned 500 during synthetic sign-in, and Docker access was unavailable. Repository policy also
forbids using the shared Docker cluster for these destructive live suites. A private production-image
Postgres with `max_locks_per_transaction=1024` is required before running them.

## 2. Screen and navigation inventory

All web registrations originate in `apps/web/src/modules/17-scheduling/screens.ts:94-184`.

| Path | Registry permission | Current purpose |
|---|---|---|
| `/calendar` | none declared | Main day/week/month/list calendar, filters, preview, create modal |
| `/scheduling/day` | `visit.read_team` | Day schedule |
| `/scheduling/week` | `visit.read_team` | Week schedule |
| `/scheduling/proposals` | `visit.proposal.read` | Pending proposal list and direct publish/dismiss |
| `/scheduling/recurring` | `recurring_visit.read` | Patient-query recurring policy list/discontinue |
| `/scheduling/time-off` | `time_off.read_team` | Team time-off queue and decisions |
| `/scheduling/visits/:visitId` | `visit.read` | Visit detail, actions, linked encounter |
| `/me/visits` | `visit.read` | Assigned clinician visits, start/arrive/encounter handoff |
| `/scheduling/clinician-credentials` | `membership_credential.read` | Credential grant/revoke administration |
| `/admin/scheduling-metrics` | `visit.read_metrics` | Scheduling metrics |

The family portal is a separate application/screen family (`apps/portal/src/screens/visits.tsx`) backed by
the narrowed portal route. It must not be merged with staff navigation or inherit staff fields.

### Proposed information architecture

```text
+----------------------------------------------------------------------+
| Scheduling                         [Today] [New visit] [More]         |
+----------------+-----------------------------------------------------+
| Calendar       | Date controls   Day | Week | Month | List          |
| Needs schedule | Filters: staff | visit type | location | status    |
| My visits      +-----------------------------------------------------+
| Staff & avail. | Authorized calendar/list content                    |
|                |                                                     |
|                +--------------------------------+--------------------+
|                | Selected visit                | Safe details/actions|
+----------------+--------------------------------+--------------------+
```

On narrow screens, the left navigation becomes tabs and List is the safe default; dense week/month grids
remain optional horizontally scrollable views. The selected visit becomes a full-width sheet/page rather
than a clipped rail.

## 3. Screen-to-API and permission matrix

`requirePermission` and ABAC in `scheduling-routes.ts:141-275` are authoritative. Registry permissions and
hidden controls are discoverability aids only.

| Screen / action | API | Server control |
|---|---|---|
| Calendar/list | `GET /api/v1/visits`, `/day-view`, `/week-view` | `visit.read`; caseload/org-wide read scope; PHI list audit |
| Visit detail | `GET /api/v1/visits/:visitId` | `visit.read`; own/caseload scope; resource read audit |
| Staff labels | `GET /api/v1/scheduling/staff` | `visit.read`; minimal name/discipline projection |
| Create candidate picker | `GET /api/v1/scheduling/eligible-clinicians` | `visit.create`; advisory only |
| Create visit | `POST /api/v1/visits` | `visit.create`; credential, discipline, PTO, caseload/pool ABAC; idempotency |
| Edit/reassign | `PATCH .../:id`, `POST .../:id/reassign` | `visit.edit` / `visit.reassign`; idempotency; gates rerun in service |
| Start/arrive | `POST .../:id/start`, `/arrive` | `visit.start`; assigned clinician; idempotency; step-up for self-attest |
| Cancel/reschedule/no-show | `POST .../:id/{cancel,reschedule,no-show}` | respective permission; legal transition; idempotency |
| Proposal inbox | `GET /api/v1/visit-proposals` | `visit.proposal.read`; audited list |
| Publish/dismiss proposal | `POST .../:id/publish`, `/dismiss` | `visit.create` / `visit.proposal.dismiss`; idempotency |
| Recurring | `GET/POST /api/v1/recurring-visits`, discontinue | read/create/discontinue permissions; idempotency on writes |
| Availability | `GET /api/v1/availability`, `PUT .../:membershipId` | read; edit-own or edit-any; server-derived authority |
| Time off | `GET/POST /api/v1/time-off`, approve/deny/cancel | own/team/approve permissions; no self-approval; idempotency |
| Route planning | `GET /api/v1/map-view`, `POST /api/v1/optimize-day` | visit read / optimize permission; PHI audit; idempotency |
| Metrics | `GET /api/v1/metrics/{visits,route-efficiency}` | separate metrics permissions |
| Portal upcoming | `GET /api/v1/portal/upcoming` | portal capability plus active patient grant/consent ABAC |
| Credentials | `GET/POST/DELETE /memberships/:id/credentials[...]` | read/grant/revoke permissions; idempotency on writes |
| On-call rotation | `GET/POST/DELETE /api/v1/oncall-rotation[...]` | read/manage permissions; idempotency on writes |

The full route declarations are `scheduling-routes.ts:307-919`. Every mutating route uses the shared
idempotency guard (`scheduling-routes.ts:141-144`).

## 4. Persona/action matrix

Tenant grants are configurable. Actual access is the intersection of permission, server-derived patient
scope, assignment, action ABAC, and tenant isolation—not a universal job-title matrix.

| Persona | Intended surface | Authoritative constraints |
|---|---|---|
| Scheduler | Org/team calendar, create, assign, proposals, recurring | Explicit grants plus credential, discipline, PTO and caseload/pool gates |
| RN case manager | Own/caseload calendar and create when granted | Caseload scope; no silent widening to org roster |
| Clinical supervisor | Team calendar, time-off decisions, scheduling when granted | Separate team/approve grants; cannot approve own request |
| Assigned clinician | `/me/visits`, visit detail, start/arrive | Exact assignment guard; self-attest start also requires fresh step-up and reason |
| Agency admin/org-admin | Configured org-wide schedule/credentials/metrics | ADR-0090 scope does not bypass tenant, credential, discipline or action predicates |
| Family portal user | Upcoming visits for the session-pinned patient | Active portal grant and consent; scrubbed projection only |

An empty eligible list, forbidden request, and no matching eligible clinician are different states and must
remain distinguishable without revealing unauthorized staff or patient facts.

## 5. Data source-of-truth matrix

| Visible concept | Authoritative source |
|---|---|
| Visit, assignment, scheduled window, current state, reasons, reminder flag | M17 `visit` (`packages/db/src/schema/scheduling/visits.ts:38-151`) |
| Immutable transition actor/source/reason | M17 `visit_state_history` (`visit-state-history.ts:18-44`) |
| Proposal source, due date/duration, suggestion, outcome/provenance | M17 `visit_proposal` (`visit-proposals.ts:27-72`) |
| Recurrence rule, local time, timezone, materialization cursor | M17 `recurring_visit` (`recurring-visits.ts:16-65`) |
| Weekly availability | M17 `clinician_availability` (`clinician-availability.ts:13-48`) |
| Time-off request/decision | M17 `time_off` (`time-off.ts:15-57`) |
| Assignment credential validity | M17 `membership_credential` (`membership-credentials.ts:19-59`) |
| Staff identity/name | M2-owned minimal membership display seam; M17 staff projection |
| Patient name/MRN | M5 patient display/read APIs; never copied into visit authority |
| Patient service address | M5 address API/seam; visit stores the selected address identifier |
| Active admission/siting | M6 admission seam; visit retains admission identifier |
| Frequency/care-plan proposal origin | M7/M15/M11/M14 events retained in proposal source/provenance |
| Encounter link/completion fact | M8 encounter and `m8.encounter.signed` consumer |
| EVV arrival/check-out/compliance | M18 events and EVV seams; scheduling must not fabricate attestation |
| Family visibility/consent | M31 portal grant plus M39 consent, not the staff visit row alone |

Free-text scheduler notes, cancellation/reschedule/no-show reasons, proposal source payload/dismissal reason,
time-off request/denial notes, and history reasons are audit denylisted. UI work must not add them to generic
analytics, notification previews, or portal responses.

## 6. Lifecycle, guards, concurrency, and errors

### Visit lifecycle

```text
proposed --publish--> published --start--> en_route --arrive--> in_visit
    |                    |  |                 |                    |
 dismiss                 |  +--no_show        +--cancel            +--complete
                         +--cancel
                         +--reschedule--> original: rescheduled
                                            replacement: published
```

Exact transitions are `packages/scheduling/src/lifecycle/visit-machine.ts:84-91`. Terminal states are
`completed`, `no_show`, `cancelled`, and `rescheduled`; there is no generic “done.” Completion is driven by
the signed-encounter/EVV integration path, not a scheduler pretending a visit occurred.

Proposal state is `pending -> published | dismissed | stale`
(`packages/scheduling/src/lifecycle/proposals.ts:189-192`). Recurring and time-off state machines should
likewise remain the sole legality source.

### Write controls

- Manual create inserts a proposed row, reruns the complete pre-schedule gate, publishes it, appends history,
  and emits `m17.visit.published` in one transaction
  (`scheduling-route-service-db.ts:649-760`). Eligibility reads are advisory and can race safely because the
  write revalidates.
- The database exclusion constraint is the concurrency backstop for overlapping published clinician
  windows. `23P01` is mapped to a 409 conflict. This design is necessary for simultaneous schedulers.
- Reschedule retains the original, creates and publishes a linked replacement in the same transaction, and
  records reasons/history (`scheduling-route-service-db.ts:1280-1345`).
- Every mutation requires `Idempotency-Key`. UI retries should refetch authoritative state after an unknown
  outcome rather than optimistically claiming success.
- Assigned-clinician checks, own-vs-any authority, portal patient binding, and org timezone are derived by
  the server. A request header/body cannot grant them (`scheduling-routes.ts:145-275`, `own-vs-any.ts`).
- Typed domain errors use the standard error envelope. The UI maps conflict, validation, permission, and
  retry cases through `scheduling-errors.ts`; unknown errors remain failures, not false empty states.

### Audit/event behavior

Visit/proposal/map read routes carry PHI audit configuration. Mutations append state history and publish the
catalogued transactional outbox events from the DB service. Relevant consumers include admission lifecycle,
care-plan proposal, encounter signed, EVV check-in/at-address/check-out/correction/late-check, SOS
cancellation, volunteer inactivation, and triage visit-needed; factories are wired in
`apps/backend/src/index.ts:15141-15183`. Green binding gates do not replace this composition-root evidence.

## 7. Current walkthroughs with fictional patients

These are code/test traces using fictional identities, not claims from an authenticated production-like
session.

### Create and assign — fictional patient “Avery Stone”

1. Scheduler opens `/calendar`, chooses **New visit**, and selects patient/admission.
2. UI asks `/scheduling/eligible-clinicians` for candidates using purpose/date context.
3. Scheduler selects location, purpose, window and clinician. The client sends an idempotency-keyed create.
4. Server rechecks active credential, discipline, PTO and caseload/unassigned-pool policy, then publishes.
5. UI refetches and opens the visit. Current risk: notes/reminder fields displayed by the UI are dropped by
   the route mapping, and local time is not explained in organization-timezone terms.

### Proposal publish — fictional patient “Jordan Lee”

1. Scheduler opens `/scheduling/proposals` and sees a pending row.
2. Current UI shows date, purpose and a patient ID fragment, not patient name/source/due window/discipline.
3. **Publish** directly uses the stored suggested membership. With no suggestion, the server rejects 422;
   there is no assignment/time editor. With a suggestion, current service publishes at 13:00–14:00 UTC.
4. **Dismiss** persists a fixed reason instead of collecting the scheduler's decision.

### Reschedule, cancel, no-show, and reassign

The visit detail action forms call separate idempotent routes. Reschedule retains original/replacement
lineage. Reassign reruns assignment gates. Cancel/no-show retain reasons and legal terminal states. The
current screen does not expose the durable transition timeline, so a reviewer cannot inspect the full
actor/reason history there.

### Time off — fictional clinician “Riley Morgan”

The team list renders a membership ID fragment, request window and state. Approve is immediate; deny uses a
fixed reason and does not preview coverage impact. The server prevents self-approval and scans affected
published visits, but the UI does not communicate that consequence before action.

### Assigned clinician and family update

The clinician uses `/me/visits` to open assigned visits, start/arrive, and continue to encounter authoring.
Self-attested start requires an EVV-missing reason and fresh server-verified step-up. Family users use the
separate portal visit screen; `/portal/upcoming` is session-pinned and consent-gated and must never expose
staff notes, internal reasons, exact route geometry, or other patients.

## 8. Browser, responsive, and accessibility evidence

Authenticated browser validation is **INCONCLUSIVE**. Synthetic login against the existing backend returned
HTTP 500, and a checkout-local backend could not start without the database. No screenshot is presented as
authenticated runtime proof.

The repository's synthetic scheduling preview was inspected at desktop, 768 px tablet, and 375 px mobile:

- Desktop calendar and rail were coherent but dense. Preview staff labels fell back to “Clinician details
  unavailable / Discipline not set,” indicating fixture/projection drift rather than production behavior.
- Tablet and narrow mobile had no document-level horizontal overflow. The week grid itself scrolls
  horizontally; at 375 px only about two days are visible. A list-first mobile route is therefore required.
- Keyboard tab order reached View options, New visit, More tools, date navigation, and view selectors in a
  sensible order. Dialog focus behavior was not validated end to end because create could not be opened in
  the synthetic harness.
- A mobile accessibility snapshot scored 93, but automated scores are not conformance. It identified
  insufficient contrast for amber availability text (about 3.18:1) and success green (about 3.29:1) at
  small text sizes. Four form controls also lacked `id`/`name` attributes.
- No M17-specific forced-colors or `prefers-contrast` treatment was found. High-contrast mode and a real
  screen reader were not exercised, so both are **NOT RUN**, not pass.
- The preview harness lacked a main landmark and viewport metadata; those harness-only findings are not
  attributed to the authenticated app shell.

Screenshots were inspected but not committed. Scheduling screenshots can contain PHI in real environments;
future evidence must use only synthetic patients and remain outside the repository unless explicitly
approved.

## 9. Existing test coverage

| Area | Current evidence | WP0 result |
|---|---|---|
| Pure visit/proposal/recurrence/time-off machines | Package unit suites | PASS |
| Overlap error classifier/client copy | DB rule + web unit suites | PASS |
| Caseload and own-vs-any authorization | Backend slice suites | PASS |
| Create/action DOM behavior | Web DOM suites | PASS |
| RLS, writes, state history, transactional outbox | `test:m17:read:live`, `test:m17:write:live` | NOT RUN — private DB unavailable |
| Create ABAC and credential validity | `test:m17:visit-create-abac:live`, `test:m17:membership-credential:live` | NOT RUN |
| On-call, EVV/SOS, correction, reminders, next visit | M17 live scripts in `package.json` | NOT RUN |
| Concurrent overlap through HTTP | No dedicated reviewed live reproduction found | GAP |
| Existing scheduling Playwright smoke | `e2e/specs/scheduling.spec.ts` via `test:e2e` | NOT RUN; narrative stale |
| Role matrix and portal isolation | Partial route/live coverage | GAP for end-to-end personas |
| DST ambiguity/nonexistent local time | No complete UI/API scenario found | GAP |
| Desktop/tablet/mobile authenticated visual | Requires working seeded stack | BLOCKED |
| Screen reader/forced colors | Manual assistive-tech pass required | NOT RUN |

The live scripts are represented in CI, including the principal M17 read/write, create-ABAC, credential and
on-call jobs. Their existence is not a pass for this branch.

## 10. Reuse, consolidate, retire, and defer

### Reuse

- Drizzle route service, pure lifecycle machines, state history, transactional outbox, RLS and audit.
- Typed `scheduling-api.ts` client and stable idempotency-key behavior.
- Authoritative eligible-clinician projection and minimal scheduling staff directory.
- Calendar date/view URL model, patient context, visit preview, existing error mapper, shared shell/list
  chrome, and design tokens.
- Current visit action forms, assigned-clinician My Visits handoff, portal-specific projection, credential
  administration, and server own-vs-any logic.

### Consolidate

- Calendar, proposal inbox, My Visits, recurring, time off and availability entry points under one
  responsive scheduling workspace while preserving permission-specific routes/deep links.
- Staff display/name loading into one minimal projection; never fall back to membership administration.
- Action error/loading/refetch behavior into shared patterns without merging distinct permissions.
- Visit detail and preview around a single safe summary model, with a separate history read if approved.

### Retire

- Stale roster/overlap comments in `screens.ts` and `e2e/specs/scheduling.spec.ts` after replacement tests
  encode the current behavior.
- Raw UUID fragments as the primary clinician/patient label.
- Fixed proposal dismissal and time-off denial reasons.
- “Server paths will be enabled later” recurring copy now contradicted by mounted APIs.
- Any UI-derived claim that a clinician is eligible; label previews as advisory.

### Defer pending separate approval

- Visit-history API and timeline.
- Proposal publish inputs/assignment/duration semantics and any proposal schema or event change.
- Recurring policy creation and availability editing UI until product/role behavior is approved.
- Route optimization/map UI and location geometry handling.
- Drag/drop scheduling, realtime collaboration/presence, external notifications, and portal action expansion.
- Any change to lifecycle states, credential policy, care-plan frequency policy, EVV attestation, billing
  behavior, or cross-module event contracts.

## 11. HIPAA/PHI threat analysis

| Surface | Threat | Required control |
|---|---|---|
| Calendar/list | Patient names, exact times and assignment exposed across scope | Server scope + RLS; non-leaking errors; no client-only filtering |
| Page/browser title | Patient identity visible in history, tabs, screen sharing | Keep title generic; never include patient/visit PHI |
| Tooltips/hover | Native tooltip currently includes patient/purpose/time/status | Minimize; ensure only authorized rendered records; test shoulder-surfing risk |
| Filters/URL | PHI copied into address bar, logs, referrers | Persist opaque IDs/enums only; never patient names, MRN, notes or reasons |
| Notifications | Lock-screen/email preview disclosure | Use existing scrubbed notification contracts; no internal notes/reasons |
| Notes/reasons | Audit/analytics/log leakage | Preserve denylist; structured safe codes where possible; no generic telemetry values |
| Route/map data | Home location, clinician movement, route geometry | Separate permission/audit; minimize coordinates; never portal or generic analytics |
| Portal | Staff/internal data or another patient disclosed | Session-pinned patient, active grant/consent, scrubbed response, RLS |
| Cross-tenant IDs | ID guessing reveals existence | Organization context + RLS + non-leaking 404; verify as NOBYPASSRLS app role |
| Screenshots/tests | Real patient data enters artifacts | Synthetic fixtures only; keep visual artifacts out of repo by default |
| Stale/aborted requests | Wrong patient appears after navigation | Abort/sequence reads and key cache by tenant/patient/query; refetch after writes |

No claim is made that WP0 independently proves HIPAA compliance. It identifies control dependencies and
required verification.

## 12. Implementation change matrix

| Class | Candidate changes | Approval boundary |
|---|---|---|
| Frontend-only | Scheduling shell/tabs; list-first mobile; URL-backed non-PHI filters; staged create UX; clearer empty/forbidden/error states; named staff/patient labels through existing reads; proposal/time-off presentation; accessibility fixes | WP1 approval; no new server semantics |
| Contract-preserving backend correction | Persist `schedulerInternalNotes` and `caregiverReminderOptIn` already accepted by schema/request and sent by UI; add regression/live coverage; remove stale comments after proof | Explicit backend approval before implementation |
| API change | Visit state-history read; richer proposal triage/publish inputs; safe patient/staff display projection changes; organization-timezone contract if existing context route is insufficient | Separate API design, permission, audit and typed-client review |
| Schema/event/policy change | Proposal duration/window semantics, new lifecycle state, recurrence policy, notification or portal contract, map/location retention | Separate architecture/module/compliance approval and migration/event review |

## 13. Proposed detailed flows

### New visit

```text
+--------------------------------------------------------------+
| New visit                                      Step 2 of 4   |
+--------------------------------------------------------------+
| 1 Patient  >  2 Visit  >  3 Clinician  >  4 Review          |
|                                                              |
| Purpose       [Routine nursing                         v]     |
| Date          [2026-11-18]  Start [09:00]  End [10:00]      |
| Timezone      America/Los_Angeles (organization timezone)    |
| Location      (o) Patient home  ( ) Facility  ( ) Telehealth |
|                                                              |
| [Back]                                      [Continue]        |
+--------------------------------------------------------------+
```

The clinician step shows advisory candidates and safe reasons such as credential mismatch or approved
time off only where authorized. Review repeats patient, admission, local timezone, location, clinician and
reminder choice. Submit remains pending until the server returns; unknown outcomes trigger a refetch.

### Proposal triage

```text
+------------------------------------------------------------------+
| Needs scheduling                            [Source v] [Date v]   |
+------------------------------------------------------------------+
| Jordan Lee | Routine RN | Due Nov 18 | Care-plan frequency       |
| Suggested: Riley Morgan | 60 min      | [Review & schedule]       |
|                                                                  |
| Avery Stone | Aide supervision | Due Nov 19 | Supervisory cadence |
| No suggestion                            [Review] [Dismiss...]     |
+------------------------------------------------------------------+
```

`Review & schedule` must not publish until the approved API can accept or validate the chosen local window,
assignment, location and duration. Dismissal collects a reason under the existing denylist.

## 14. Risk register

| Risk | Severity | Evidence / mitigation |
|---|---|---|
| UI reports saved notes/reminder that server dropped | High | Fix mapping with route/live regression before claiming completion |
| Proposal publishes wrong UTC hour or cannot handle no suggestion | High | Decide proposal scheduling contract; do not hide with frontend defaults |
| Tenant/caseload PHI exposure during workspace consolidation | High | Preserve server reads/RLS; test app role and non-leaking IDs |
| Concurrent overlapping assignment | High | Keep exclusion constraint; add HTTP concurrent live test for 409/one winner |
| Browser-local time silently shifts DST/org date | High | Display org timezone; add ambiguous/nonexistent-time scenarios |
| Portal/internal-field disclosure | High | Preserve dedicated scrubbed route/grant; contract tests |
| UI progress presented as audit history | Medium | Label current state honestly; add history only through approved audited API |
| Dense mobile week view blocks field use | Medium | List-first narrow layout; retain optional grid scroll |
| Contrast and dialog semantics impair access | Medium | Token-based contrast fix, focus trap/restore, live errors, screen-reader pass |
| Stale comments/tests reintroduce obsolete fixes | Medium | Replace narratives with executable assertions before deleting comments |
| Rollback after API expansion breaks old frontend | Medium | Additive contracts first; preserve current endpoints through rollout |

## 15. Proposed PR sequence

1. **PR 08-0 — Audit and approval:** this evidence document only. No application changes. **STOP.**
2. **PR 08-1 — Shell and safe navigation:** consolidate entry points, URL-backed non-PHI filters,
   permission-aware presentation, responsive/list-first structure, and accessibility baseline.
3. **PR 08-2 — Create flow plus approved correction:** staged form over existing APIs; organization-timezone
   presentation; notes/reminder persistence fix only if explicitly approved; targeted unit/DOM/live tests.
4. **PR 08-3 — Calendar/detail:** responsive views, safe preview/detail consolidation, error/empty states;
   history timeline only if its API is separately approved.
5. **PR 08-4 — Proposals/staffing:** approved proposal triage contract, recurring/time-off/availability
   improvements, and no speculative schema/event changes.
6. **PR 08-5 — Release evidence:** private live DB, authenticated persona matrix, Playwright, screen reader,
   forced colors, desktop/tablet/mobile synthetic screenshots, operational rollout and rollback evidence.

Each implementation PR must state contract impact and non-goals, use synthetic data, run change-scoped
checks, and distinguish blocked/not-run suites from passes. Before a PR, run the repository-mandated fresh
code review and any required React/security reviews. Merging still requires explicit user approval.

## Approval gate

WP0 is complete as an evidence audit. The remaining browser and live-DB items are explicitly recorded as
blocked/not run; they are not represented as passes. Await explicit approval before WP1 or any backend/API
change.
