# ChartWarden — Patient Admission Workflow Redesign

**Target repository path:** `docs/implementation/02-patient-admission-workflow-redesign.md`
**Executor:** Claude Code
**Status:** Proposed implementation plan; discovery and approval gates required
**Sequence:** Workflow 02, after Unified Intake
**Scope:** Referral-to-admission handoff, admission creation, notice-of-rights acknowledgement, election and consent visibility, certification/CTI readiness, admission activation, and post-activation handoff.
**Source:** Inspected `chartwarden-main.zip` uploaded November 14, 2026. This is a static code review, not a runtime UX test.

## 0. Mission

Make admission a **single guided, task-oriented experience** where an intake coordinator or clinician can answer at any moment:

1. Which patient and admission am I working on?
2. What has already been completed?
3. What is the next permissible action?
4. What is blocking activation, who can resolve it, and where do I click?
5. Which items have deadlines but are **not** prerequisites to admission activation?

Preserve existing backend state machines, server-computed activation gate, tenant and site scope, audit trail, clinical signatures, and regulatory controls. **Do not replace the admission domain model with a UI stepper.**

### Non-goals

- Rewriting the admission backend, database schema, or Rust migration.
- Replacing the existing election, CTI, face-to-face, HOPE, or billing engines.
- Making AI determinations of hospice eligibility or automatically signing clinical records.
- Creating new PHI persistence in browser storage.
- Moving regulatory deadlines or declaring every downstream assessment a pre-activation blocker.
- Copying Patrium branding, styles, or unverified proprietary behavior.

## 1. Verified code anchors and constraints

The following files **exist in the supplied ZIP**. Claude Code must recheck their contents and current line numbers in the actual checkout before editing:

| Path                                                                                     | Observed role / evidence                                                                                                                                                                      | Preserve                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/web/src/modules/06-admission/admission-create.tsx`                               | Uses `StepperWorkflowLayout`, `WorkflowStepper`, `StickyFooterActions`; comment says direct intake draft is React state only because no durable draft endpoint exists                   | Existing create semantics, validations, and no PHI in browser storage |
| `apps/web/src/modules/06-admission/admission-detail.tsx`                               | Uses `DetailPageLayout`, `GateStepper`, `GuardChip`; comments identify `GET /api/v1/admissions/:id` and server-derived activation gate                                                | Readiness source of truth and legal state transitions                 |
| `apps/web/src/modules/06-admission/admission-readiness-presentation.ts`                | Defines statuses `complete`, `action_required`, `awaiting_signature`, `pending`, `blocked`, `overdue`, `not_applicable`; groups `setup`, `notices`, `clinical`, `other` | Do not flatten clinically meaningful distinctions                     |
| `apps/web/src/modules/06-admission/patient-election-cert.tsx`                          | Patient-scoped election/certification view; comments identify `GET /api/v1/patients/:patientId/election-certification`                                                                      | Authoritative patient-scoped state and authorization                  |
| `apps/web/src/modules/06-admission/intake-workspace.tsx`                               | Existing guided intake shell with `receive`, `verify`, `match`, `review`, `handoff`, `requirements`                                                                               | Avoid creating a second competing intake/admission wizard             |
| `apps/backend/src/modules/06-admission/state-machines/admission.ts`                    | Admission lifecycle state machine                                                                                                                                                             | No frontend-invented transitions                                      |
| `apps/backend/src/modules/06-admission/routes/admission-routes.ts`                     | Admission API routes                                                                                                                                                                          | Existing contracts and server authorization                           |
| `apps/web/src/modules/06-admission/__tests__/admission-detail-activation.dom.test.tsx` | Activation UI regression coverage                                                                                                                                                             | Extend, do not delete                                                 |
| `apps/web/src/modules/06-admission/__tests__/admission-readiness-presentation.test.ts` | Readiness presentation tests                                                                                                                                                                  | Preserve all status mappings                                          |
| `apps/backend/__tests__/admission-readiness.test.ts`                                   | Backend readiness tests                                                                                                                                                                       | Preserve clinical gate invariants                                     |
| `apps/backend/__tests__/admission-workflow-acceptance.test.ts`                         | Admission workflow acceptance tests                                                                                                                                                           | Preserve end-to-end domain behavior                                   |

**Critical verified comment in `admission-detail.tsx`:** A new admission starts `pending`; the notice-of-rights acknowledgement advances it to `notice_of_rights_acknowledged`; only then is `activate` a legal transition, subject to the **same server `activationGate.ready`** that the route enforces. Treat this as an invariant to verify against executable code, not as a reason to bypass a gate.

**Repository state warning:** The supplied ZIP already contains `intake-workspace.tsx` and an intake workspace test. Do not assume the prior intake plan is unimplemented or fully finished. Compare it against the actual branch, inspect git history and outstanding PRs, and integrate with the existing implementation rather than duplicating it.

## 2. Mandatory Gate G0 — Current-state audit

Before editing code, create `docs/implementation/02-admission-current-state-audit.md` with **file:line evidence** for:

1. Navigation map: referral worklist → intake workspace → admission create/detail → patient chart → election/certification → activation → care team handoff. Include back navigation and deep links.
2. All actual create, acknowledgement, activation, signature, and evidence-upload endpoints; payload schemas; permission checks; tenant/site filters; audit/outbox side effects; idempotency and retry handling.
3. Full admission lifecycle state diagram from the backend state machine, including legal/illegal transitions and terminal/hold states.
4. Server activation-gate computation, blocker codes, reason messages, override semantics, and how UI derives grouped readiness statuses.
5. Election statement, notice of rights, addendum, CTI, F2F, benefit period, and HOPE dependencies; distinguish **must exist before activation** from **due after admission** using the current policy engine and applicable regulatory requirements.
6. Existing shared UI components and Lantern token sources; responsive patterns and accessibility coverage.
7. Current automated tests and missing tests; identify live-DB, mail, storage, or other blocked test prerequisites.
8. Potential duplicate data entry and screens that require switching contexts to resolve one blocker.
9. Role-based scenarios: intake coordinator, admitting RN, physician/medical director, administrator, compliance reviewer, and unauthorized user.
10. Exact current relationship between `intake-workspace.tsx` and `admission-create.tsx` to prevent parallel workflow ownership.

Separate **verified defects**, **usability hypotheses**, and **requirements needing product/clinical approval**. Record baseline screenshots or browser recordings where a runnable test environment exists; otherwise state `NOT RUNTIME VERIFIED`.

**G0 acceptance:** An auditor can trace every proposed UI action to an existing route or identify a separately approved backend change. No implementation before this map exists.

## 3. Target user experience

### 3.1 Single admission entry point

After intake handoff, land in the existing admission context, not a fresh disconnected wizard. Show a compact persistent header:

- Patient identity, MRN where authorized, admission/episode context, assigned team and location.
- Current admission state in plain language with the canonical state accessible in details.
- **Next action** and a short explanation of why it matters.
- `Save and exit` only when there is actually something saveable; never imply an unsaved draft is durable.
- History and authorized administrative actions under secondary controls.

If users enter through the patient chart or a deep link, display the same admission progress and next-action guidance.

### 3.2 Admission overview — one task board

Render three distinct sections, backed by existing server state:

1. **Required before activation:** true blocking requirements, sorted by severity and dependency; each row has a plain-language explanation, owner, and working deep link.
2. **Awaiting another person:** signature/approval tasks with status and responsible discipline. Do not allow staff to impersonate the required signer.
3. **After admission / upcoming deadlines:** HOPE, follow-up certifications, and other time-based obligations where applicable. Never misrepresent them as prerequisites if the server does not.

A single primary action should reflect the next **legal** transition. When activation is not permitted, replace the action with an explanation and the highest-priority resolvable task. Avoid enabled buttons that predict success contrary to the backend.

### 3.3 Guided sections (presentation, not new states)

Recommended visual sections:

1. **Admission information** — patient, referring provider, dates, coverage, admission context. Prefill from verified intake values without silent overwrites.
2. **Election and notices** — election statement, authorized signer, notice-of-rights acknowledgement, applicable addendum tasks, evidence and signatures.
3. **Physician certification** — CTI, certifying physician, signature status, benefit-period context, and F2F where applicable.
4. **Clinical preparation** — care team, initial clinical tasks, HOPE and other assessments, clearly classified by timing and gate semantics.
5. **Review and activate** — server-derived readiness, outstanding blockers, explicit confirmation ceremony, authorized activation, and successful handoff.

Do not require the user to complete these in an arbitrary sequence when the backend permits parallel work. Show progress per requirement, not a fabricated percentage of clinical completion.

### 3.4 Blocker resolution

Each blocker should contain:

- Human-readable name, current status, why it blocks or when it is due.
- Source of truth: server code / requirement ID (accessible in a details panel).
- Who can resolve it, and direct link to the actual form or document.
- Last update / evidence state where available.
- Correct error and recovery states for failed requests.

For unavailable actions, say why: missing role, another signature required, prerequisite incomplete, record locked, or unknown error. Never use a generic `Complete` button without a real handler.

### 3.5 Activation ceremony

- Show the actual server readiness result immediately before confirmation.
- Enforce `pending → notice_of_rights_acknowledged → active` or the verified state-machine equivalent; no skipped acknowledgement.
- Require the backend's role and scope checks; the frontend only guides.
- Use a confirmation dialog with patient/admission context and consequences.
- Prevent duplicate submissions while a request is in flight; handle retries/idempotency as supported by backend.
- On stale readiness or conflict, refresh and show the changed blocker rather than reporting success.
- After success, display actual new status and clear links to patient chart, first visits, care plan, and required follow-up work.

## 4. Visual and accessibility specification

Use the existing **Lantern** system and `@chartwarden/ui`. Respect repository token parity checks. No purple gradients, stock imagery, AI-themed decoration, or new bespoke primitives when shared equivalents exist.

**Desktop:** patient header, compact progress navigation, central active task, optional right-hand `Needs attention` panel; one primary CTA. **Tablet/mobile:** one column, accessible step navigation, no clipped modals or horizontal scrolling, sticky action only if it does not hide content.

Target WCAG 2.2 AA: keyboard operability, logical focus restoration, error summaries linked to fields, status communicated without color alone, meaningful labels, screen-reader announcements for status changes, adequate contrast and touch targets. Test zoom at 200% and narrow viewport widths.

## 5. Engineering work packages

### WP1 — Baseline and preservation matrix

**Tasks:** Complete G0; inventory current screens, route ownership, API calls, state machines, token usage, and tests. Write a matrix of `Existing behavior → Proposed presentation → API unchanged? → Tests`. Confirm what the prior Intake implementation already delivers.

**Acceptance:** All proposed changes map to actual code; explicit sign-off for any contract or workflow change.

### WP2 — Admission overview and shell

**Tasks:** Refactor the admission detail presentation into reusable sections. Introduce a consistent patient/admission header, next-action guidance, and task-first overview. Preserve existing route paths and deep links. Use feature flag if existing rollout conventions support it.

**Acceptance:** Every current authorized action remains reachable; no duplicate navigation; patient and tenant context remain correct.

### WP3 — Readiness and blockers

**Tasks:** Adapt `admission-readiness-presentation.ts` and its consumers to show blockers first, action owners, meaningful statuses, and direct resolution links. Reuse the existing server gate; avoid a second client eligibility engine.

**Acceptance:** A `blocked` server gate can never appear ready in UI; `awaiting_signature`, `overdue`, `pending`, `not_applicable`, and override evidence remain distinguishable; every blocker has a valid destination or explicit explanation.

### WP4 — Election, notice, and certification navigation

**Tasks:** Connect admission overview to existing election, notice, CTI, F2F, and signature surfaces. Avoid duplicating the underlying forms. Display applicable timing and authorized signers. Keep patient-scoped election/certification links working.

**Acceptance:** Existing signatures, evidence uploads, authorization, and audit behavior are unchanged; no unauthorized signer can complete another person's ceremony.

### WP5 — Activation and handoff

**Tasks:** Simplify the acknowledge-NOR and activation ceremonies, refresh server readiness at the decision point, handle stale state/conflicts, and display post-activation next actions. Do not activate as a side effect of opening a page or reviewing a checklist.

**Acceptance:** Both legal and illegal transitions behave exactly as backend policy dictates; double-clicks and retries do not create duplicate activation effects.

### WP6 — Responsive UX and accessibility

**Tasks:** Test desktop, tablet, and mobile widths; keyboard and screen reader flows; loading/empty/error states; role-specific visibility; patient-context switching; safe back navigation.

**Acceptance:** No trapped focus, inaccessible blocker links, hidden critical status, or lost context.

### WP7 — Verification, rollout, and documentation

**Tasks:** Run relevant tests and typecheck/lint/token parity gates; perform a scripted usability walkthrough; produce before/after screenshots; update navigation and workflow documentation; ship behind an existing feature flag if supported; document rollback.

**Acceptance:** All applicable gates pass, blocked gates are identified with evidence, and rollback does not alter admission domain state.

## 6. Mandatory test matrix

| Scenario                                     | Expected result                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| New admission in `pending`                 | Acknowledge-NOR is available only to authorized users when applicable; Activate is not prematurely offered |
| NOR acknowledged, gate not ready             | Activation blocked with exact server-derived reasons                                                       |
| NOR acknowledged, gate ready                 | Authorized user can confirm activation; UI reflects authoritative new state                                |
| Activation clicked twice / network retry     | No duplicate side effects; honest pending/result state                                                     |
| Readiness changes between load and submit    | Conflict/error refreshes blockers, never shows false success                                               |
| Missing election signature                   | Correct signature owner, requirement and action displayed                                                  |
| Missing CTI or relevant F2F                  | Requirement shown according to applicable timing and server policy                                         |
| HOPE item due after admission                | Appears as upcoming/due work, not automatically a pre-activation blocker                                   |
| Not-applicable or overridden requirement     | Correct semantics and evidence retained; no false `complete`                                             |
| Patient with multiple episodes / readmission | Correct admission and benefit period, no cross-episode leakage                                             |
| Cross-tenant or cross-site URL access        | Backend denies; UI reveals no unauthorized PHI                                                             |
| Unauthorized role attempts activation        | Server denies even if frontend controls are bypassed                                                       |
| Intake handoff with verified data            | No unnecessary re-entry; source data preserved; no silent overwrites                                       |
| API failure or session expiry                | Clear recovery path without leaking PHI or fabricating success                                             |
| Keyboard-only / screen reader / 200% zoom    | Entire workflow usable with clear status and focus behavior                                                |

Extend existing tests under `apps/web/src/modules/06-admission/__tests__/` and backend admission suites. Use synthetic patients only. Do not disable tests to obtain a green result. Record commands, pass/fail counts, and environmental blockers.

## 7. Safety, regulatory and security gates

- **Authoritative backend:** Activation readiness, state transitions, signatures, and timing rules must remain server-enforced.
- **Clinical responsibility:** Only authorized clinicians/physicians may make or attest clinical determinations; do not auto-complete them based on document extraction.
- **HIPAA:** Minimum necessary access, no PHI in client analytics, logs, URLs where avoidable, browser localStorage/sessionStorage, screenshots or test artifacts.
- **Tenant isolation:** Preserve org, site, patient, admission, and benefit-period scoping on every read and mutation.
- **Audit:** Preserve actor, timestamp, action, affected resource, evidence/version and relevant outcomes according to existing audit architecture.
- **Regulatory review:** Validate election, notice, CTI, F2F, HOPE, and admission timing rules against current CMS regulations and existing product policy before altering labels or requiredness. Flag disagreements for compliance review; do not silently change policy.
- **Migration boundary:** Do not modify `chartwarden-rust` or redesign TS/Rust routing as part of this UI task. Record API contract dependencies for future parity.

## 8. Delivery / PR sequence

| PR   | Scope                                                                                       | Gate                                                           |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| PR 0 | `02-admission-current-state-audit.md`, workflow diagram, preservation matrix, screenshots | **G0 approval before feature edits**                     |
| PR 1 | Admission overview shell, navigation, task hierarchy                                        | Existing route/API tests pass                                  |
| PR 2 | Readiness presentation, blockers, deep links, status semantics                              | Server/UI gate parity tests pass                               |
| PR 3 | Election/CTI navigation, activation ceremony and post-activation handoff                    | Legal-transition, permissions and duplicate-request tests pass |
| PR 4 | Accessibility, responsive refinements, E2E scripts, docs and rollout                        | Regression and compliance sign-off                             |

Avoid broad rewrites or massive mixed PRs. Keep backend untouched unless G0 demonstrates a necessary change; propose it separately with API migration and parity tests.

## 9. Definition of done

- [ ] One coherent admission journey from intake handoff to activated patient chart.
- [ ] Staff can identify the next legal action and the top blocking reason without navigating through unrelated tabs.
- [ ] Every actionable blocker resolves to a real, permission-aware workflow.
- [ ] Existing NOR, election, certification, HOPE, and activation safeguards are preserved.
- [ ] No parallel readiness engine or duplicated admission lifecycle introduced.
- [ ] All applicable unit, integration, E2E, accessibility, typecheck, lint, and design-token gates pass or have documented blockers.
- [ ] Usability review with synthetic cases shows fewer context switches and no critical task failures; capture baseline and post-change measurements rather than inventing success metrics.
- [ ] Screenshots, change log, known limitations, rollback plan, and code evidence delivered.

## 10. Claude Code execution instructions

1. Read this document, the existing Intake plan, repository instructions, and module-06 specifications.
2. **Inspect current checkout before trusting ZIP paths or this document's observations.** Record commit SHA and branch.
3. Execute **G0 only** and create `docs/implementation/02-admission-current-state-audit.md`. Cite file paths and line ranges, list unverified assumptions, and propose exact components to edit.
4. **STOP and request approval** for the current-state map, UX boundaries, and any policy/API changes. Do not implement in the same pass unless explicitly authorized.
5. After approval, implement PR 1–4 incrementally, running focused tests after each change and broader gates before merge.
6. Never claim runtime validation, CMS compliance, or test success without supporting evidence.
7. Return a concise handoff containing changed files, screenshots, test commands/results, known risks, and next approval gate.

**Success criterion:** Admission becomes easier to understand and complete, while ChartWarden's server remains the sole authority on whether an admission can legally and safely advance.
