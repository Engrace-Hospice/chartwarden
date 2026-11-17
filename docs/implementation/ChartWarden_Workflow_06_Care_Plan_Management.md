# ChartWarden — Workflow 06: Care Plan Management UX and Workflow Redesign

**Repository destination:** `docs/implementation/ChartWarden_Workflow_06_Care_Plan_Management.md` (this file; the audit is [`06-care-plan-current-state-audit.md`](./06-care-plan-current-state-audit.md))
**Executor:** Claude Code
**Status:** WP0 audit complete (2026-11-15) and its **defect track** applied; **the Unified Workspace redesign (WP1–WP6) still requires explicit approval before product-code changes**
**Sequence:** After Workflow 05 (HOPE Assessments); before Workflow 07 (Discipline-Specific Care Plans)
**Baseline:** Static inspection of user-supplied `chartwarden-main.zip` (November 14, 2026). No authenticated browser run, production database, live service, or clinician usability study was performed.
**Primary goal:** Replace a fragmented and cognitively demanding care-plan experience with a coherent patient-scoped workflow, while retaining authoritative lifecycle, clinical, signature, access-control, and audit behavior.

---

## 0. Executive decision

Build a **Unified Care Plan Workspace** with a visible and understandable progression:

**Open patient → Review current plan → Identify problems → Define measurable goals → Assign interventions and responsible disciplines → Review readiness → Obtain required signatures → Publish/current version → Monitor and revise → IDG review.**

This is an **information-architecture and UX modernization**, not authorization to replace the domain engine, invent a second plan record, bypass required signers, or silently change Medicare hospice requirements.

Every screen must answer: **What is the current plan? What changed? What is missing? Who must act? What can I safely do next?**

**Non-negotiable:** Clinical decisions remain with authorized staff. AI may propose draft wording only when separately approved, with evidence, provenance, and human confirmation; it must not autonomously sign, finalize, publish, or modify an active plan.

## 1. Repository evidence and boundaries

These are **observed source anchors**, not proof that every workflow operates end-to-end. Recheck paths, contracts, feature flags, and current branch before implementation.

| Source anchor                                                                                                                   | Observed responsibility                                                                                                         | Design implication                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/web/src/modules/07-care-plan/care-plan-view.tsx`                                                                        | ~3,245 lines; substantial UI involving problems, goals, interventions, versions, signers, readiness, review, and IDG references | High-value candidate for decomposition; line count alone does not prove defects |
| `apps/web/src/modules/07-care-plan/care-plan-overview.tsx`                                                                    | ~588 lines; presentational pieces only (plan header, KPI stats, goal cards, intervention table, quick-link rail), not a summary   | Reuse as building blocks of the workspace header/snapshot                       |
| `apps/web/src/modules/07-care-plan/summary.tsx`                                                                               | Separate patient/family-friendly read-only page over `GET /care-plans/:id/summary`; does not overlap the workspace              | Keep separate; it is a different audience and permission (`care_plan.read_summary`) |
| `apps/web/src/modules/07-care-plan/version-history.tsx`                                                                       | Standalone two-route page (version list + snapshot detail); there is **no diff** — the only diff is the proposed-change diff in `care-plan-view.tsx` | A real before/after comparison is new work, not a discoverability fix           |
| `apps/web/src/modules/07-care-plan/screens.ts`                                                                                | Registers four param-path screens with `requiredPermission`; no navigation entries                                              | Preserve route identities and authorization checks                              |
| `apps/web/src/modules/07-care-plan/care-plan-api.ts`                                                                          | Reads, signer-set normalisation, error mapping and `bootstrapCarePlan` are live; the twelve typed write helpers were not used by the view (see audit §5) | Reuse APIs; do not introduce speculative endpoints                              |
| `apps/web/src/modules/07-care-plan/care-plan-status.ts`                                                                       | Status → badge tone map and `cap()` only; not a lifecycle                                                                       | Map labels to server enums (`packages/db/src/enums.ts`); no independent frontend lifecycle |
| `apps/backend/src/modules/07-care-plan/routes/care-plan-routes.ts`                                                            | ~531 lines; route-level permissions, scope, finalize/sign operations, idempotency, version checks, and signing controls         | Preserve authorization, concurrency, and signing preconditions                  |
| `apps/backend/src/modules/07-care-plan/lifecycle/care-plan.ts`                                                                | Pure root lifecycle graph `draft → active → discharged` (version graph in `version.ts`: `draft → in_review → signed → superseded`); at the audited revision the production DB service did **not** call these machines (only tests did) — the live rules are ad-hoc status checks | The graph is the intended contract; verify the DB service enforces it before calling it authoritative |
| `apps/backend/src/modules/07-care-plan/lifecycle/validation.ts`                                                               | Lifecycle validation                                                                                                            | Present errors contextually; never duplicate rules as final authority           |
| `apps/backend/src/modules/07-care-plan/lifecycle/required-signer-set.ts`                                                      | Required signer logic                                                                                                           | Display actual signer requirements from backend                                 |
| `apps/backend/src/modules/07-care-plan/lifecycle/version.ts`                                                                  | Version semantics                                                                                                               | Protect historical immutability and revision lineage                            |
| `apps/backend/src/modules/07-care-plan/lifecycle/gate-clock.ts`, `overdue-gate.ts`                                          | Timing and overdue gates                                                                                                        | Do not replace server deadlines with client calculations                        |
| `apps/backend/src/modules/07-care-plan/authoring/`                                                                            | Discipline, goal attribution, redaction                                                                                         | Preserve authorship and discipline permissions                                  |
| `apps/backend/src/modules/07-care-plan/problem-proposals-db.ts` and `routes/problem-proposal-routes.ts`                     | Problem proposal path                                                                                                           | Clarify proposal versus approved/active plan element                            |
| `apps/backend/src/modules/07-care-plan/outbox-consumers/m14-idg-decision-recorded.ts` (+ `m14-idg-proposal-guards.ts`) | The live IDG consumer: turns a recorded decision into governed *proposals* on a draft `idg_review` version (nothing is applied until the version reaches signer quorum, in `applyIdgProposalChanges`); an undeliverable decision is recorded as a durable `conflict` refusal, not dropped. The earlier pure decider `consumers/apply-idg-decision.ts` was dead code and has been removed | Avoid duplicate writes from frontend; the UI only reads proposals |
| `apps/backend/src/modules/07-care-plan/outbox-consumers/`                                                                     | Admission, IDG and diagnosis-related consumers                                                                                  | Maintain cross-module event behavior and idempotency                            |
| `apps/web/src/modules/15-discipline-care-plans/plan-workspace.tsx`                                                            | Separate discipline-plan workspace with versions/signing                                                                        | Do not merge domain ownership without architecture review                       |
| `apps/web/src/modules/15-discipline-care-plans/`                                                                              | Aide, MSW, spiritual, volunteer, assessment and IDG revision screens                                                            | Provide coherent navigation to these, but reserve deep redesign for Workflow 07 |
| `apps/backend/__tests__/care-plan-workflow-acceptance.test.ts`, `care-plan-lifecycle.test.ts`, `care-plan-routes.test.ts` | Existing care-plan tests                                                                                                        | Reuse and extend regression coverage                                            |
| `apps/web/src/modules/07-care-plan/__tests__/care-plan-workspace.dom.test.tsx`, `apps/web/src/modules/07-care-plan/care-plan-writes.dom.test.tsx` (note: **not** under `__tests__/`), `care-plan-api.attempt-key.test.ts` | Existing UI tests                                                                                                               | Extend to complete user journeys                                                |
| `e2e/specs/care-plan.spec.ts`                                                                                                 | E2E entry point; both functional scenarios skip unless `E2E_CARE_PLAN_*` env is set, which no CI job sets, and their selectors predate the current UI | Rewrite against the real UI and seed the env before relying on it               |

**Architectural constraint:** Care plan (module 07), discipline-specific plans (module 15), IDG (module 14), admission (module 06), assessments, and HOPE are distinct domains. Design one navigational experience, **not** one giant mutable aggregate or an unreviewed cross-module write API.

## 2. Mandatory WP0 — Current-state audit (STOP GATE)

**No application code changes during WP0.** Create the audit at `docs/implementation/06-care-plan-current-state-audit.md` (the repo convention of the Workflow 03/04/05 audits, not `evidence/`) containing:

1. Repository SHA, branch, deployment configuration, feature flags, and status of Workflows 02–05.
2. Route-by-route walkthrough: patient chart → plan summary → authoring → problems/goals/interventions → readiness → finalize → sign → revisions → IDG → historical version.
3. Role/permission matrix for RN, physician/medical director, MSW, chaplain, aide, supervisor, compliance reviewer, and other actual configured roles. Separate visibility from mutation permission.
4. State-transition table from `lifecycle/care-plan.ts`, including permitted actors, server preconditions, effects, forbidden transitions, terminal states, and recovery paths.
5. Exact endpoint inventory with request/response types, optimistic concurrency/ETags or equivalent, idempotency keys, and generated-client dependencies.
6. Source-of-truth matrix for problems, goals, interventions, ownership, statuses, deadlines, required signatures, plan versions, and related IDG decisions.
7. Screen inventory with screenshots at desktop and tablet widths, actual click paths, repeated entry, competing buttons, modals, unsaved state, and broken/dead navigation.
8. Evidence of current handling for conflicting edits, stale versions, double-submit, partial save, network failures, forbidden actions, and revoked access.
9. Patient/tenant isolation and any special sensitive-data restrictions, including consent and redaction behavior.
10. Integration mapping: initial assessment, HOPE, diagnosis writeback, discipline-specific plans, visit notes, IDG decisions, admission/discharge, and family-facing summaries where applicable.
11. Current validation rules and required signers; distinguish CMS requirements, agency-configurable policy, and implementation-specific rules. Verify applicable CMS Conditions of Participation and current policy with authoritative sources before changing logic.
12. Existing automated tests, skipped tests, fixtures, live-database dependencies, and known coverage gaps.
13. Usability baseline: time/clicks to add a problem, link a goal, assign intervention, finalize, sign, and revise; collect at least three realistic role-specific scenarios using synthetic patients.
14. Risk register and list of changes that **cannot** be frontend-only.

**WP0 deliverables:** evidence report, screen/route map, lifecycle diagram, permission matrix, API contract map, before screenshots, test baseline, proposed UI wireframes, and a PR plan with dependencies. **Stop and request explicit approval.**

## 3. Target experience — Unified Care Plan Workspace

### 3.1 Global structure

Patient chart → **Care Plan** opens one consistent workspace with:

- **Header:** patient identity (minimum necessary), active plan version/status, effective date if available, owner, last reviewed timestamp, and one primary next action.
- **Progress/attention rail:** current status, blockers, due reviews, unsigned requirements, recent IDG recommendations; all sourced from server responses.
- **Main content:** Overview | Problems & Goals | Interventions | Team & Signatures | History. Use tabs/sections, not independent competing workflows.
- **Context panel:** assessment/HOPE findings, linked visit evidence, IDG decisions, source provenance, and relevant policies. Avoid rendering sensitive information to unauthorized roles.
- **Persistent controls:** Save draft, Review readiness, Request signatures/Finalize (only when allowed). Never show several equal-weight primary actions.

Do not use a fake five-step completion percentage if the backend cannot support it. A UI stage is a **projection** of existing domain state and tasks, not a new persisted state machine.

### 3.2 Overview (default landing)

Show, in this order:

1. **Plan status** — the **actual** server states only. Root plan (`care_plan_status`): `draft`, `active`, `discharged`. Version (`care_plan_version_status`): `draft`, `in_review` (sent for signatures), `signed`, `superseded`. "Pending signature" is a projection of `in_review`; there is no "revision pending" state — it is "an open draft or `in_review` version exists beside the active one".
2. **Next action** — e.g., “Complete two interventions,” “Physician signature required,” or “Review IDG recommendation,” with direct deep link.
3. **Clinical snapshot** — active problems, goals, interventions, participating disciplines, and important review dates.
4. **Attention list** — actionable blockers grouped by owner and severity, not a wall of error strings.
5. **Recent activity** — changes, authorship, and timestamps with access to full audit/history.

Empty state: “No care plan has been started” with an authorized, clearly named start action; if starting is blocked, explain why.

### 3.3 Problems and goals

- Show problem → linked goals → interventions as a **readable hierarchy**; preserve underlying IDs and attribution.
- Support creating/editing a problem with a structured form: description, clinical context, source, responsible discipline, status, and permitted metadata actually supported by contracts.
- Each goal must be measurable where clinically appropriate, include target/outcome fields supported by the backend, and visibly link to its parent problem.
- Separate **suggested/proposed** problems from accepted/current problems; never silently promote a suggestion.
- Make add/edit/reorder affordances obvious; do not invent ordering semantics or write APIs.
- For unsupported data elements, either omit the field or propose a separately approved backend contract change.

### 3.4 Interventions and responsibilities

- Present each intervention under its goal, with discipline, frequency/assignment where supported, and status.
- Make responsibility and next action explicit. Do not treat a discipline label as proof of a signed order or visit assignment.
- Offer a guided “Add intervention” action with validation, safe defaults only where clinically justified, and server-confirmed save.
- Surface conflicting/missing assignments as warnings, not silently inferred values.
- Link to discipline-specific plans (module 15) via navigation rather than copying or overwriting their records.

### 3.5 Readiness, finalization, and signatures

- Readiness panel must consume **authoritative backend** validation/gate results.
- For each blocker show plain-language description, severity, owning role, and a direct route to resolve it.
- Distinguish **draft saved**, **ready for finalization**, **finalized**, **partially signed**, and **fully effective/current** according to actual server semantics. Never imply that a saved draft is a signed clinical order.
- Preserve the server-defined signer set (a quorum of role slots; there is **no signing order**), identity verification, step-up requirements, and concurrency controls.
- On forbidden or stale actions, show actionable errors; do not auto-retry non-idempotent signatures.
- Signing UI must show exactly which version is being signed and require re-review when its content changes.

### 3.6 Revision and history

- Show current published version separately from draft revision.
- Display author, date, reason, changed problems/goals/interventions, signatures, and effective status where available.
- Provide a readable before/after comparison if source data permits; otherwise present version-specific snapshots without inventing a diff.
- Keep signed version **snapshots** immutable (the `state_snapshot` is frozen by a database trigger and a signed version is only ever superseded). The model is hybrid: the plan's live problem/goal/intervention rows are the working copy and stay editable on an `active` plan; a signed revision is a new version. The UI must say which of the two it is showing and must not call live rows "signed".
- Expose IDG recommendations as **pending review**, **applied**, or other actual persisted states; never silently apply a proposed change merely because it is displayed.

### 3.7 Cross-workflow context

- **Workflow 04 Initial Assessments:** link to relevant findings; copying into a care plan requires explicit provenance and clinician confirmation.
- **Workflow 05 HOPE:** show pertinent assessment context without conflating HOPE reporting completion with care-plan approval.
- **Workflow 07 Discipline Plans:** link to aide/MSW/spiritual/volunteer plans with accurate ownership and signature state.
- **IDG:** show decisions, due actions, and applied changes with clear event lineage; preserve module 14 authority.
- **Visits:** expose intervention-to-visit context only where supported; no automatic claim that an intervention was performed.
- **Admission/discharge:** preserve lifecycle effects, review clocks, and closeout behavior.

## 4. Lantern design system and accessibility

- Use **existing ChartWarden Lantern tokens** and shared `@chartwarden/ui` primitives; inspect `packages/ui/src/core/theme/colors.ts` and `apps/web/src/index.css` before authoring styles.
- No purple gradients, arbitrary color systems, decorative stock imagery, or generic AI dashboard styling.
- Strong hierarchy, readable typography, concise labels, generous spacing, consistent buttons and feedback.
- Responsive desktop/tablet and narrow mobile layouts without horizontal clipping; no assumption that clinicians will complete complex signatures on mobile.
- WCAG 2.2 AA target where applicable: keyboard access, logical focus, screen-reader labels, contrast, touch target sizing, visible error text, non-color-only status, and accessible dialogs.
- Persistent save-state feedback (“Saving,” “Saved,” “Unable to save”), unsaved-change warning, and explicit retry semantics.
- Never display unverified success or optimistic “signed”/“finalized” status before server acknowledgment.

## 5. Work packages and execution gates

### WP1 — Design and contracts (no backend change)

**Tasks**

1. Create desktop/tablet wireframes and a clickable prototype for overview, problems/goals, interventions, readiness/signatures, and version history.
2. Define UI-to-backend mapping for every displayed status, count, action, validation message, and timestamp.
3. Identify which existing components can be reused and which should be extracted from `care-plan-view.tsx`.
4. Draft component architecture and route-preserving migration plan.
5. Validate with RN, hospice medical director or authorized signer, MSW, and clinical supervisor using fictional scenarios.

**Exit criteria:** No invented states/endpoints, design-system parity, reviewed clinical copy, accessibility review, and sign-off on wireframes. **STOP for approval.**

### WP2 — Workspace shell and overview

**Tasks**

1. Implement patient-scoped workspace shell behind a reversible feature flag if infrastructure supports one; otherwise document rollback path.
2. Retain existing deep links and route permissions; redirect only after compatibility checks.
3. Build server-derived status header, next-action summary, blockers, and clinical snapshot.
4. Add loading/empty/forbidden/error states and restore navigation context.
5. Add telemetry for anonymized workflow events (no PHI in analytics).

**Acceptance:** Existing records open correctly; tenant/caseload restrictions enforced; no duplicate fetch storm; old links work; responsive and keyboard-accessible.

### WP3 — Problems, goals, and interventions

**Tasks**

1. Extract manageable, tested components from the current large view without altering write semantics.
2. Build hierarchical presentation and focused create/edit flows using existing typed API client.
3. Preserve attribution, validation, required fields, role/discipline scopes, and problem proposal distinctions.
4. Handle concurrency, duplicate clicks, server rejection, partial failure, and retry correctly.
5. Use existing idempotency/attempt-key conventions; do not synthesize unsafe retry keys.

**Acceptance:** Every edit round-trips to server; stale edits do not overwrite newer data; proposal/approved states remain distinct; no cross-patient writes.

### WP4 — Readiness, signing, and revision

**Tasks**

1. Build a unified readiness view from existing server results with deep-linked resolution actions.
2. Build signer task list reflecting server-required signers and version-specific signature state.
3. Add explicit confirmation of version and content before sign/finalize.
4. Expose revision history, immutable signed snapshots, and IDG change provenance.
5. Test negative paths for forbidden sign, stale version, missing signer, incomplete readiness, and network interruption.

**Acceptance:** No unauthorized finalization; no signature on stale content; no hidden blockers; historical versions remain intact.

### WP5 — Cross-module links and navigation cleanup

**Tasks**

1. Link assessment and HOPE findings contextually, read-only by default.
2. Link module 15 discipline plans and module 14 IDG decisions without duplicating records.
3. Preserve admission/discharge events, diagnosis writeback, and outbox consumer behavior.
4. Remove redundant menu entries or dialogs only after route usage and permission analysis.
5. Ensure patient context survives transitions and browser Back behavior.

**Acceptance:** Clinicians can navigate related work without losing the current patient or draft; no cross-domain mutation outside approved contracts.

### WP6 — Verification, rollout, and documentation

**Tasks**

1. Run relevant unit, DOM, integration, E2E, typecheck, lint/Biome, and build commands from the repository; record exact results.
2. Execute synthetic patient journeys with at least RN, signer, MSW, and read-only roles.
3. Perform authenticated accessibility and responsive testing; test screen-reader and keyboard paths.
4. Conduct live-DB tests only in an approved isolated environment; never use production PHI for fixtures.
5. Compare user-task time/clicks/errors to WP0 baseline and capture before/after screenshots.
6. Roll out to internal pilot users with rollback switch or reversible deployment plan.
7. Update relevant ADR/design docs, support documentation, and operational runbooks.

**Acceptance:** No severity-1/2 regressions, no unresolved tenant or signing failures, documented results, clinician sign-off, rollback rehearsed.

## 6. Mandatory test matrix

Each test must name the actual fixture, role, route/API, expected persisted state, and audit event where applicable.

| ID    | Scenario                           | Expected outcome                                           |
| ----- | ---------------------------------- | ---------------------------------------------------------- |
| CP-01 | Open plan from patient chart       | Correct patient, version, status, and permitted actions    |
| CP-02 | Patient with no plan               | Clear empty state and authorized start action              |
| CP-03 | Save new draft problem             | Persisted under correct patient/org; visible after reload  |
| CP-04 | Add measurable goal to problem     | Correct linkage and attribution                            |
| CP-05 | Add intervention to goal           | Correct discipline and relationship                        |
| CP-06 | Missing required field             | Field-level error; no false success                        |
| CP-07 | Save interrupted by network loss   | Draft retained where supported; clear retry/no duplication |
| CP-08 | Two clinicians edit same version   | Conflict handled; no silent overwrite                      |
| CP-09 | Double-click save/finalize         | No duplicate mutations                                     |
| CP-10 | Proposed problem awaiting review   | Not shown as approved active element                       |
| CP-11 | Readiness incomplete               | Server blocker prevents finalization                       |
| CP-12 | Readiness complete                 | Allowed action only for authorized role                    |
| CP-13 | Unauthorized signer                | Server rejects and UI accurately explains                  |
| CP-14 | Required signer set incomplete     | Plan state remains correct; missing signer visible         |
| CP-15 | Sign a stale version               | Reject or require refresh; never attach to wrong version   |
| CP-16 | Signed plan revised                | New version created; signed snapshot of the original unchanged and superseded only at the new quorum |
| CP-17 | View old version                   | Accurate immutable snapshot and signers                    |
| CP-18 | IDG decision arrives               | Correct review/application semantics and provenance        |
| CP-19 | Admission/discharge event          | Existing lifecycle effect preserved                        |
| CP-20 | Assessment/HOPE navigation         | Contextual links preserve patient and authorization        |
| CP-21 | Discipline plan navigation         | Correct module 15 records; no cross-write                  |
| CP-22 | Cross-tenant patient ID            | No data disclosure; authorization enforced server-side     |
| CP-23 | Restricted caseload/role           | Redacted or denied according to backend policy             |
| CP-24 | Sensitive consent restriction      | Protected information not leaked through UI or logs        |
| CP-25 | Keyboard-only workflow             | Every action reachable with visible focus                  |
| CP-26 | Screen reader announcements        | Status, validation, and save feedback announced            |
| CP-27 | Tablet/narrow viewport             | No clipped actions or unusable tables                      |
| CP-28 | Back/refresh with unsaved draft    | Explicit warning or safe draft persistence                 |
| CP-29 | API error/timeout                  | Honest error; no fake finalized/signed state               |
| CP-30 | Old bookmarked route               | Safe compatibility or intentional redirect                 |
| CP-31 | Audit trail after write/sign       | Actor, version, timestamp, and event captured              |
| CP-32 | Revision pending during IDG review | No unintended auto-publication or lost changes             |

**Additional regression suites:** existing care-plan lifecycle/route/workflow tests, care-plan-to-IDG tests, admission integration, diagnosis writeback, module 15 discipline plans, and authorized E2E smoke coverage. Do not mark live-DB suites as passed when blocked or not run.

## 7. Safety, privacy, and regulatory safeguards

- **HIPAA:** Preserve minimum necessary access, auditability, access revocation, secure transport/storage, and no PHI in client analytics, error monitoring, or browser logs.
- **Tenant isolation:** Every read/write/sign action must be server-authorized for tenant, patient, and actor. UI hiding is never a security boundary.
- **Clinical integrity:** Do not silently transform assessment findings into finalized care plan elements. Preserve source and author attribution.
- **Signatures:** Never simulate or cache success; respect server signer rules, step-up verification, and immutable signed versions.
- **CMS hospice rules:** Verify current 42 CFR Part 418 requirements and organization policies before altering timing, care plan content, review intervals, physician involvement, or IDG behavior. The redesign should **not** change those rules by default.
- **Audit events:** Existing immutable audit/outbox behavior must remain; do not put full PHI in audit descriptions when not necessary.
- **No destructive migration:** Avoid schema migrations unless WP0 identifies a proven missing contract and a separate ADR, migration, backfill, rollback, and tests are approved.
- **No AI autopublish:** If drafting assistance is later introduced, it must be opt-in, traceable, validated, and clinically reviewed.

## 8. Suggested PR sequence

| PR   | Scope                                                      | Merge gate                                               |
| ---- | ---------------------------------------------------------- | -------------------------------------------------------- |
| PR-0 | Audit evidence, design proposal, risk register             | Explicit owner/clinical approval; no application changes |
| PR-1 | Workspace shell, overview, navigation, empty/error states  | Existing routes/permissions and DOM tests pass           |
| PR-2 | Problems/goals/interventions authoring                     | Contract, concurrency, and negative-path tests pass      |
| PR-3 | Readiness, signer tasks, history/revision                  | Lifecycle/signature invariants proven                    |
| PR-4 | Cross-module links, accessibility, pilot and documentation | E2E, clinical usability, rollout and rollback gates pass |

Keep PRs small and independently reviewable. Do not combine unrelated backend refactors, Rust migration, or schema redesign into this UX project.

## 9. Definition of done

- [ ] WP0 audit completed with exact SHA, evidence, routes, lifecycle, permissions, and baseline.
- [ ] Clinical/product owner approves the design before code changes.
- [ ] One patient-scoped care-plan entry point with unambiguous next action.
- [ ] Existing problems/goals/interventions and proposals preserved with correct attribution.
- [ ] Readiness, finalization, and signatures remain server-authoritative.
- [ ] Current, draft, pending, and historical versions clearly differentiated.
- [ ] IDG and discipline plans linked without duplicating their authoritative records.
- [ ] Tenant/caseload authorization, sensitive-data rules, audit, and concurrency tests pass.
- [ ] Desktop/tablet accessibility and error/empty states validated.
- [ ] Existing API contracts and deep links preserved or explicitly migrated.
- [ ] Test commands/results and remaining risks recorded; blocked tests are not claimed as passing.
- [ ] Pilot sign-off and rollback plan completed.

## 10. Claude Code execution prompt

> You are implementing ChartWarden Workflow 06 — Care Plan Management. Read this entire document, the relevant current source files, architectural decision records, design-system tokens, and the prior Workflow 02–05 plans. **Execute WP0 only first. Do not modify application code until the owner explicitly approves the current-state audit and target design.**
>
> Verify all source anchors and domain contracts on the current Git SHA; never treat this plan as proof of current implementation. Preserve the module 07 lifecycle graph, role/tenant/patient authorization, versioning, signing, idempotency, outbox integration, module 14 IDG ownership, and module 15 discipline-plan ownership. Use the existing Lantern style and shared UI primitives. Avoid new backend endpoints or schema changes unless evidence demonstrates necessity and a separate change is approved.
>
> After WP0, present: (1) verified current workflow and pain points, (2) state/permission/API mapping, (3) proposed screen architecture and mockups, (4) exact files to change, (5) test plan, (6) risks and rollback, and (7) PR breakdown. **Stop for approval.** Once approved, implement in small PRs and report actual commands, test results, and limitations without claiming unrun checks passed.

---

**Next planned review:** Workflow 07 — Discipline-Specific Care Plans. This plan intentionally links to that module but does not redesign its independent authoring and signature workflows.
