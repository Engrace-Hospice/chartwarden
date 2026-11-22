# ChartWarden — Workflow 08: Visit Scheduling Redesign

**Repository destination:** `docs/implementation/08-visit-scheduling-workflow-redesign.md`
**Executor:** Claude Code
**Status:** PROPOSED — WP0 audit and explicit approval required before application changes
**Sequence:** After Workflow 07 (Discipline-Specific Care Plans), before Workflow 09 (Clinical Visits & Documentation)
**Baseline:** Static inspection of user-supplied `chartwarden-main.zip`, November 2026. No authenticated browser execution, database test, or production validation was performed.
**Goal:** Make scheduling, assigning, publishing, rescheduling, and monitoring hospice visits straightforward for authorized coordinators and clinicians while preserving the existing M17 scheduling domain, server authorization, visit lifecycle, care-plan-driven proposals, and downstream encounter/EVV/billing integrations.

---

## 0. Executive decision

Create **one Scheduling Workspace** with clear views for **Calendar**, **Unscheduled / Proposed**, **My Visits**, and **Staff & Availability**. The experience must answer, immediately:

1. What visits are scheduled today or this week, and for whom?
2. Which visits still need to be scheduled or assigned?
3. Who can safely and legally take a visit, and why is an assignee unavailable?
4. What conflicts or deadlines require action?
5. What happened to a visit after reschedule, cancellation, no-show, start, or completion?

**Do not** create a second visit state machine, bypass credential/caseload checks, move authorization to the frontend, manufacture visit completion, or silently alter scheduling frequencies. Preserve the Lantern design system and existing ChartWarden brand tokens; avoid introducing new purple/gradient styling.

**Target journey:** Patient care plan / IDG / supervisory requirement → proposed visit → coordinator triage → select patient, discipline/purpose, qualified clinician, location and time → server validates assignment/conflicts → publish visit → clinician sees My Visits → visit execution (Workflow 09) / EVV (Workflow 10) → encounter and downstream reporting → changes and exceptions remain auditable.

The UI should also support an authorized direct-create path when no proposal exists. **Scheduling a visit is not the same as documenting or completing the visit.**

## 1. Verified codebase anchors (revalidate on current branch)

| Source path | Observed role / implication |
|---|---|
| `apps/web/src/modules/17-scheduling/screens.ts` | Registers calendar, day/week, My Visits, proposals, recurring policies, time off, visit detail, credentials and metrics; source comments document earlier access and conflict problems. |
| `apps/web/src/modules/17-scheduling/calendar-page.tsx` | ~1,568-line calendar with day/week/month/list modes, staff filters, selected visit details, proposal and availability rails. Candidate primary shell; audit overlapping views before consolidation. |
| `apps/web/src/modules/17-scheduling/scheduling-workflow.tsx` | ~1,210-line shared scheduling UI, visit representation and create/edit ceremonies. Candidate extraction into focused components. |
| `apps/web/src/modules/17-scheduling/scheduling-api.ts` | Generated-operation-derived write types and API wrappers; preserve typed contracts and error handling. |
| `apps/web/src/modules/17-scheduling/day-view.tsx`, `week-view.tsx`, `my-visits.tsx`, `visit-detail.tsx`, `visit-table.tsx` | Existing scheduling and clinician perspectives; retain useful capabilities and routes. |
| `apps/web/src/modules/17-scheduling/proposals.tsx`, `recurring.tsx`, `time-off.tsx`, `clinician-credentials.tsx` | Unscheduled proposals, recurrence, absence and credential-related workflows. |
| `apps/web/src/modules/17-scheduling/scheduling-errors.ts`, `scheduling-status.ts`, `visit-attestation.tsx` | Error translation, status vocabulary, and sensitive visit attestation handling. |
| `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts`, `scheduling-typebox.ts`, `service.ts`, `scheduling-route-service-db.ts` | Server-side API, validation, authorization, and persistence. |
| `apps/backend/src/modules/17-scheduling/routes/own-vs-any.ts`, `abac-predicates.ts`, `seams/credentials.ts` | Own/team/org scope and clinician eligibility/credential rules. |
| `packages/scheduling/src/lifecycle/visit-machine.ts` | Authoritative eight-state visit lifecycle; guard decisions remain server-side. |
| `packages/scheduling/src/lifecycle/proposals.ts`, `recurrence.ts`, `availability.ts`, `time-off-machine.ts` | Authoritative proposal, recurrence, availability and time-off semantics. |
| `packages/db/src/schema/scheduling/visits.ts`, `visit-proposals.ts`, `recurring-visits.ts`, `clinician-availability.ts`, `time-off.ts`, `visit-state-history.ts` | Persistent state, history and constraints. |
| `apps/backend/src/modules/17-scheduling/consumers/`, `outbox-consumers/` | Admission, care-plan, IDG, EVV, on-call, safety and visit event integrations. |
| `apps/backend/src/modules/08-encounters/consumers/seed-visit-encounter.ts` | Scheduled visit to encounter relationship; do not duplicate. |
| `apps/portal/src/screens/visits.tsx` | Family-facing visit information; distinguish from staff scheduling. |
| `e2e/specs/scheduling.spec.ts`, `apps/web/src/modules/17-scheduling/__tests__/visit-workflow.dom.test.tsx`, `scheduling-writes.dom.test.tsx` | Existing tests and documented historical gaps; confirm whether issues remain. |

### Specific source findings requiring investigation

1. `screens.ts` explicitly records an **historical clinician roster permission problem**: the assignment picker used `GET /api/v1/orgs/:id/members`, requiring `member.manage`, which RN case managers and supervisors lacked. `calendar-page.tsx` describes a newer minimal M17 scheduling directory. **Determine whether every create/reassign entry point now uses the safe scheduling directory; do not assume the old defect persists.**
2. `screens.ts` and `e2e/specs/scheduling.spec.ts` record a **historical overlap error**: Postgres `23P01` from a partitioned no-overlap exclusion constraint surfaced as HTTP 500 rather than an actionable 409. **Reproduce on current code; fix only with evidence and explicit backend approval.**
3. `screens.ts` notes deferred drag-and-drop rescheduling (reason required), availability editing, recurring-policy creation, OSRM mapping, and mobile Today/Map. **Treat these as unverified scope candidates, not promises or mandatory features.**
4. `scheduling-api.ts` documents server ownership of lifecycle and pre-schedule gates. **UI may display advisory availability, but must never claim an assignment is valid until the server accepts it.**
5. `visit-machine.ts` documents `proposed → published → en_route → in_visit → completed`, plus cancellation, no-show and rescheduling paths. **Use exact current states and legal transitions; do not reduce them to an invented generic “done” state.**

## 2. WP0 — Mandatory current-state audit (STOP GATE)

**No application code changes in WP0.** Create `docs/implementation/evidence/08-visit-scheduling-current-state.md` with:

- Current branch, commit SHA, clean/dirty status, package manager, runnable scripts, and architecture/ADR references.
- Exact route inventory, navigation paths, screen-to-API matrix, read/write permissions, and user personas (scheduler, RN case manager, supervisor, assigned clinician, agency admin, family portal user).
- Source-of-truth matrix for visits, proposals, recurring schedules, availability, time off, credentials, patient addresses, admission/care-plan context, encounter and EVV status.
- Real state transition graph, server guards, error codes, idempotency, concurrency and audit events.
- Screen walkthroughs using fictional patients: create, proposal publish, assign, reschedule, cancel, no-show, time off, clinician My Visits and family-visible updates.
- Evidence for whether historical roster and `23P01` problems still exist; reproduce with a failing test if possible.
- Screenshot-based UX review at desktop, tablet and narrow mobile widths; keyboard, screen reader and high-contrast checks.
- Existing test coverage and which tests actually execute against a live database; distinguish blocked/not-run from passing.
- Explicit list of existing features to reuse, consolidate, retire or defer, with file and line references.
- HIPAA/PHI threat analysis for scheduling lists, calendar titles, notification previews, location/route data and cross-tenant access.
- Proposed changes split into frontend-only, contract-preserving backend corrections, and schema/API changes needing separate approval.

**STOP:** Present findings, precise screen map, proposed wireframes, risk register, and PR breakdown. Await explicit approval before WP1. Do not make unsupported claims about CMS compliance or live behavior.

## 3. Proposed information architecture

### 3.1 Main workspace

**Header:** `Scheduling` + selected date range + view toggle (`Day | Week | Month | List`) + `Schedule visit` primary action. Keep patient/care team filters visible but compact; persist valid filters in URL for shareable, refresh-safe navigation.

**Primary tabs / sections:**

- **Calendar:** actual scheduled visits only; clear clinician, patient, purpose, time, location and state; accessible list alternative to color-coded blocks.
- **Needs scheduling:** care-plan/IDG/supervisory proposals, missing assignment, conflict resolution and overdue requirements; show source and next action.
- **My Visits:** clinician-specific agenda, patient context, contact/location and clear handoff to Workflow 09; scope server-enforced.
- **Staff & Availability:** authorized roster/credentials/availability/time off; show what the user can read or edit based on server capabilities.

Use a contextual **visit details drawer** instead of forcing navigation for every common action. Keep the existing dedicated visit detail route for deep links, history, and complex actions. A selected visit must not silently change while editing.

### 3.2 Scheduling wizard — one focused flow

1. **Who and why:** patient + active admission; proposed visit context if launched from a proposal; discipline, purpose, frequency source.
2. **When and where:** local service date, time window, time zone, address/facility/setting; warn about DST ambiguity and impossible windows.
3. **Who is available:** scheduling-safe directory of permitted clinicians; show active roster and separately indicate *verified eligible* only if a backend endpoint supplies authoritative eligibility. Explain empty roster, insufficient permissions, credential failure, time-off and conflicts distinctly.
4. **Review & schedule:** concise summary, source provenance, server-validation response; submit once with idempotency; preserve draft on recoverable error.

If the current API cannot return reasons for ineligible clinicians without leaking sensitive data, use server error messages and safe summaries rather than a client-side eligibility engine. Do not require new endpoints merely to draw a prettier form.

### 3.3 Proposal triage

Show `Patient | Visit purpose | Source | Due window | Suggested discipline | Status | Next action`. Support publish/dismiss only through existing authorized server ceremonies. Dismissal must require the existing reason policy, if any. Distinguish **proposal** from **scheduled visit**; never mark a proposal scheduled before a successful publish response.

### 3.4 Reschedule, reassign, cancel, no-show

Provide explicit actions with clear consequences and server-required reasons. For rescheduling, show original visit and replacement linkage; for reassignment, show old/new clinician; for cancellation, show reason and affected downstream consumers. Do not implement unconfirmed drag/drop as a shortcut around reason capture or step-up.

### 3.5 Time off, recurring schedules and credentials

Preserve dedicated advanced workflows while exposing relevant blockers in scheduling. Recurring visit editing must preview proposed instances and preserve recurrence policy semantics; avoid generating future visits in the browser. Time-off approval must not be confused with availability changes. Credential displays must not imply that a role grant equals a current professional license.

## 4. WP1 — Scheduling shell and navigation

**Deliverables**

- Introduce a coherent Scheduling Workspace with Calendar / Needs scheduling / My Visits / Staff & Availability entry points, reusing existing screens where possible.
- Preserve existing deep links and route permissions; add redirects only after verifying link consumers.
- Use Lantern tokens/components, clear typography, high contrast, compact density controls, responsive layouts and consistent empty/loading/error states.
- Add context-aware patient links, breadcrumbs, a visible selected date range and filter reset.
- Never show PHI in unauthorized tooltips, browser titles, analytics payloads or push previews.

**Acceptance:** all existing URLs remain usable; role-specific nav is correct; keyboard-only user can reach each primary task; no extra server state is introduced.

## 5. WP2 — Visit creation and assignment UX

**Deliverables**

- Refactor the existing create/edit ceremonies into smaller typed components; reuse `scheduling-api.ts` generated operation types.
- Add explicit four-step create flow with inline validation, back/forward persistence and safe submission state.
- Use the existing minimal scheduling directory where authorized; resolve any obsolete `member.manage` dependency only after WP0 confirmation.
- Surface server conflict errors clearly, including overlap, credentials, caseload, approved time off, inactive admission, invalid purpose or out-of-scope patient.
- Implement disabled-action explanations and nontechnical error copy, without hiding server error details from support/audit tooling.

**Acceptance:** RN case manager/supervisor can complete their *authorized* scheduling tasks; no permission widening; rejected assignment never appears successful; repeated submit does not create duplicates.

## 6. WP3 — Calendar and visit details

**Deliverables**

- Consolidate redundant day/week/calendar presentation logic without deleting needed features.
- Keep Day, Week, Month and List views; provide accessible textual equivalents to visual indicators.
- Make visit details available in a drawer plus a stable deep-link page, with history and clear status timeline.
- Support reschedule/reassign/cancel/no-show through existing backend contracts, reason fields, and confirmation dialogs.
- Show encounter/EVV linkage as read-only contextual indicators; route to their own workflows rather than editing them in Scheduling.

**Acceptance:** refresh preserves view/date/filter; no stale selected-visit data after mutation; history remains traceable; state-changing actions obey server guards.

## 7. WP4 — Proposal, recurring and staffing workflows

**Deliverables**

- Create a prioritized Needs Scheduling inbox using actual proposal statuses and authoritative due dates.
- Make `Publish`, `Dismiss`, and `Open source` unambiguous; handle duplicates and already-processed proposals safely.
- Show approved time off, clinician availability and credential blockers where existing read APIs permit.
- Only implement recurring-policy creation or availability editing if WP0 establishes backend support and a separately approved scope; otherwise document deferral.
- Include patient/care-plan/IDG provenance where authorized; never duplicate event consumers.

**Acceptance:** proposal → published visit has exactly one authoritative outcome; time-off conflict is explained; downstream state remains consistent.

## 8. WP5 — Integration, safety and authorization hardening

Audit and preserve the following:

- **RBAC/ABAC/RLS:** organization scoping, patient caseload, own vs any scope, credentials, discipline-purpose match, time off, scheduling permissions, step-up where required.
- **State machine:** no invalid transitions, silent reopenings, or client-side state changes masquerading as persisted visits.
- **Database conflicts:** verify overlap exclusion behavior, error translation and 409 mapping; any change must not turn unrelated database failures into false conflicts.
- **Concurrency/idempotency:** two schedulers competing for same clinician/time; stale updates; repeat publish; retries after timeout.
- **Audit:** actor, patient, admission, before/after schedule, reasons, and immutable history without PHI leakage in logs.
- **Downstream:** encounters, EVV, care-plan frequency, IDG, field safety, portal visibility, notifications, reporting and billing visit lines. Test real event consumers, not mocked UI alone.
- **Clinical operations:** on-call or urgent visit needs must not be hidden by ordinary calendar filters; do not imply automated dispatch unless implemented.

**Backend changes are conditional.** Any required change to contracts, database constraints, authorization or consumers must be separately described, tested, reviewed and approved; avoid opportunistic migrations.

## 9. WP6 — Verification, usability, release and rollback

### Mandatory test matrix

| ID | Scenario | Expected result |
|---|---|---|
| S01 | Authorized scheduler creates a visit | Persisted once, correct patient/admission and state |
| S02 | RN case manager schedules within permissions | Success or explicit authorization reason, never silent empty picker |
| S03 | Clinical supervisor schedules within permissions | Same behavior with scope enforced |
| S04 | Unauthorized user opens org-wide schedule | No cross-scope PHI |
| S05 | User from tenant A guesses tenant B visit ID | No existence disclosure or mutation |
| S06 | Patient lacks an eligible active admission | Server rejects with actionable message |
| S07 | Clinician credential expired/missing | Assignment rejected; role grant not treated as license |
| S08 | Clinician discipline incompatible | Rejected server-side |
| S09 | Clinician on approved time off | Rejected with safe conflict explanation |
| S10 | Two visits overlap for same clinician | Conflict surfaced as actionable error, not generic 500 |
| S11 | Two schedulers submit overlapping visits concurrently | At most one conflicting booking succeeds |
| S12 | Double-click create / retry after timeout | No duplicate visit |
| S13 | Publish proposal | Exactly one visit, proposal status updated, provenance retained |
| S14 | Publish same proposal twice | Safe idempotent/rejected behavior; no duplicate |
| S15 | Dismiss proposal | Requires valid reason if policy demands; auditable |
| S16 | Reschedule visit | Valid replacement linkage and reason, old visit retained in history |
| S17 | Reassign visit | Credential and caseload gates rerun |
| S18 | Cancel visit | Reason captured; downstream consumers react correctly |
| S19 | No-show | Legal transition and history, not marked completed |
| S20 | EVV check-in/check-out event | Correct scheduling state progression, no synthetic attestation |
| S21 | Self-attested start | Existing reason length and step-up enforced |
| S22 | Linked encounter created | Correct one-to-one or documented expected linkage |
| S23 | Patient/family portal visit updates | Only authorized patient-visible information shown |
| S24 | Time-zone/DST edge case | No silent shift or invalid local time |
| S25 | Day/week/month/list filters and refresh | Stable URL state, consistent visit counts |
| S26 | Empty roster vs forbidden roster vs no eligible staff | Distinct accessible explanations |
| S27 | Slow API, stale result, and aborted request | No wrong-patient display or false success |
| S28 | Keyboard and screen reader use | Dialog focus, labels, status announcements work |
| S29 | Mobile narrow viewport | No clipped controls; safe list alternative to dense calendar |
| S30 | Visit history and audit | Actor, action, reason, timestamps correct and immutable |
| S31 | Care-plan or IDG generated proposal | Source preserved and scheduling respects frequency policy |
| S32 | Approved time-off change while scheduling | Server revalidates at commit; no race bypass |
| S33 | Invalid or unavailable facility/address | Actionable validation without PHI leak |
| S34 | Visit cancellation impacts billing/EVV | Downstream state verified; no orphan charge assumptions |
| S35 | Existing E2E scheduling smoke test | Runs on repeatable fixture with clean teardown |
| S36 | Rollback to previous frontend | Existing API and route behavior preserved |

### Required checks

- Run repository-prescribed formatting, lint/Biome, TypeScript, affected unit/DOM tests, backend scheduling tests, API contract checks, and relevant live-DB/E2E suites.
- If a test cannot run due to missing services, fixtures, credentials or resources, mark **BLOCKED**, not PASS.
- Perform authenticated visual checks using at least scheduler, RN case manager, clinical supervisor and assigned clinician roles; use fictional data.
- Record before/after screenshots, accessibility findings, task completion and error rates. Do not claim measured improvement without measurements.
- Confirm the existing architecture and design-token gates pass; avoid hardcoded colors.

### Release strategy

1. Feature-flag new Scheduling Workspace by tenant/role if existing flag infrastructure supports it; otherwise use a reversible route-level deployment plan.
2. Release frontend consolidation before any approved backend changes.
3. Run a small internal pilot with fictional patients, then a controlled clinical pilot with authorized users and rollback owner.
4. Monitor schedule creation success, conflict classification, duplicate attempts, proposal aging, page errors, authorization denials and downstream consumer failures. Metrics must avoid PHI.
5. Roll back UI independently where possible. For approved database changes, provide migration-specific recovery; do not promise irreversible migrations can be rolled back safely.

## 10. Proposed PR sequence

- **PR 08-0 — Audit and design approval:** evidence document, flow diagrams, route/permission matrix, wireframes, test baseline. **No application changes. STOP for approval.**
- **PR 08-1 — Workspace shell:** navigation, calendar consolidation, responsive and accessible layout, backward-compatible routes.
- **PR 08-2 — Visit create/assign UX:** typed wizard, scheduling-safe roster, error presentation, draft/retry semantics.
- **PR 08-3 — Proposal and visit actions:** triage inbox, detail drawer, reschedule/reassign/cancel/no-show UI, staffing context.
- **PR 08-4 — Verified defects and hardening:** only approved backend fixes, authorization/conflict regression tests, cross-module integration and E2E.
- **PR 08-5 — Release evidence:** accessibility/usability results, pilot/rollout instructions, rollback and operations documentation.

Each PR must include scope, changed files, contract impact, screenshots where UI changed, test evidence, risk analysis, and explicit non-goals. Avoid unrelated refactors.

## 11. Definition of done

- A coordinator can find the next scheduling task without knowing internal module names.
- Authorized staff can schedule or publish a visit with clear feedback, and disallowed actions explain the blocker without leaking sensitive data.
- The same visit has one authoritative state and one auditable history across Calendar, My Visits, patient chart, EVV and encounters.
- Scheduling conflicts are safe, reproducible and actionable; no unauthorized clinician assignment is possible.
- Calendar and proposal views are accessible, responsive, and consistent with Lantern.
- All changed workflows have passing tests, or explicitly documented blockers that prevent release.
- No tenant isolation, patient confidentiality, clinical authorization, lifecycle, billing or audit regression.
- WP0 approval, PR review, pilot sign-off and rollback documentation are recorded.

## 12. Instructions to Claude Code

1. Open this plan and inspect the **current repository**; do not trust line counts, historical source comments or the November archive as proof of current behavior.
2. Read relevant architecture documents, ADRs, module contracts, generated API types, database schemas and the previous Workflow 06/07 redesigns.
3. **Execute WP0 only.** Create the evidence document with concrete file/line references, reproduced issues, screenshots where possible, and an implementation change matrix.
4. Report which assumptions were disproved. Do not invent missing routes, permission keys, or CMS requirements.
5. **STOP and request approval.** Do not implement WP1–WP6 until approved.
6. Once approved, implement one PR at a time; preserve server authority and all existing cross-module consumers.
7. Report commands, results, tests not run, and risks after every PR. Never represent static review or mock tests as production validation.

**Next workflow:** 09 — Clinical Visits & Documentation.
