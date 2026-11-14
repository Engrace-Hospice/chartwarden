# ChartWarden — Unified Hospice Intake Workspace

**Implementation specification**
**Status:** Proposed; requires repository discovery and validation before code changes
**Scope:** Referral intake through admission handoff, with DocLens-assisted review where existing capabilities permit
**Primary constraint:** Preserve the existing backend contracts, clinical controls, tenant isolation, audit trail, and ChartWarden Lantern design tokens. Do not copy Patrium branding or assume its undocumented behavior.

> **Repository truth rule:** This plan intentionally does **not** rely on the previously uploaded ZIP or the unrelated attachment. All paths, components, route names, endpoint behavior, and available features mentioned below are *discovery targets*, not verified facts about the current checkout. Inspect the repository and cite code evidence in your implementation notes before editing.

## 0. Mission and non-goals

Build a single, understandable **Intake Workspace** that guides hospice staff from receipt of a referral through review, patient matching, eligibility/coverage checks, required admission documentation, and a safe handoff to admission. A user should always know (1) where they are, (2) what is missing, (3) who owns the next action, and (4) what happens next.

The experience should borrow the **document-first, extract → verify → proceed** interaction pattern demonstrated publicly by Patrium Health, without assuming Patrium supports hospice-specific Medicare election, certification, NOE, or HOPE workflows. ChartWarden must retain those regulatory and clinical controls.

**Non-goals for initial delivery:** rewriting admission domain logic; replacing patient matching; creating an autonomous eligibility determination engine; changing billing submission behavior; allowing AI output to become verified clinical data without review; building a new design system; migrating the Rust/Bun architecture; introducing a new PHI-processing vendor without approval and appropriate agreements.

## 1. Mandatory discovery gate — before implementation

You must inspect the **current checkout** and produce `docs/implementation/intake-current-state-audit.md` containing:

1. Actual app locations, package scripts, routes, navigation entries, design-system token source, and component library.
2. Current referral inbox/create/detail, patient search/match, DocLens/document ingestion, admission creation/detail, consent/election, CTI, HOPE, and readiness UI paths **if they exist**. Record `file:line` evidence; mark absent features `NOT FOUND`.
3. API routes and payloads, mutations, validation schemas, authorization checks, tenant-scoping mechanisms, database ownership, server-derived readiness, and audit-event writers.
4. State transition diagram: referral states, admission states, conversion points, irreversible actions, and side effects. Include retry/idempotency behavior.
5. Current tests, accessibility checks, E2E fixtures, known blockers, and environment dependencies.
6. Inventory of duplicate data entry, confusing navigation loops, competing status labels, hidden blockers, and disconnected document-review steps. Separate **observed code facts** from **UX hypotheses requiring user testing**.
7. A preservation matrix of existing routes/APIs/permissions/clinical controls and proposed UI wrappers. Identify any change that truly needs backend work; obtain approval before modifying those contracts.

**Gate G0:** Do not implement until the audit is written and the proposed workflow is mapped to real repository capabilities. Do not invent file paths or silently scaffold parallel workflows.

## 2. Target experience

### 2.1 Worklist (`Intake`)

One entry point with primary **New intake** action. Show actionable work rather than raw system status:

- Needs review
- Waiting on information
- Ready for next step
- In progress
- Completed / closed

These are **derived presentation labels**, not new canonical database states. Document exact mapping to current backend statuses and ensure every underlying state has a deterministic mapping. Filters: assigned to me/team, urgency, referral source, received date, patient, and blocked reason. Accessible search and sort; clear empty/error/loading states. Avoid misleading “ready” labels if required clinical gates remain open.

### 2.2 Guided Intake Workspace

Single persistent page/shell with a clear stepper and contextual content:

1. **Receive referral** — upload supported documents, attach existing referral, or manually enter minimal information. Preserve original files and provenance.
2. **Verify information** — show source document alongside extracted fields where an extraction service exists. Human accepts, edits, or rejects each field; clearly distinguish unverified, conflicting, missing, and confirmed data. Manual path works without AI.
3. **Match patient** — search existing patients, present possible duplicates, confirm match or create a new patient through existing backend logic. No silent patient creation or merging.
4. **Review clinical and coverage requirements** — show required facts, clinical review, payer/coverage status, referral physician, and missing evidence. Display source and owner for each blocker. **Never present AI extraction as a hospice eligibility decision.**
5. **Complete admission requirements** — expose election/consents, physician certification/CTI, assessments/HOPE and related tasks at the appropriate point according to existing workflows and applicable rules. Respect existing timing, signature, and authorization gates.
6. **Review and hand off** — concise summary of verified data, unresolved issues, required signatures, readiness results, and next owner. Trigger the existing admission/conversion transition only after server validation.

The six steps are a **UX model**. If the existing domain has different legal/state boundaries, keep the domain boundaries and adjust the display model accordingly. Do not imply that every HOPE or CTI requirement must be completed before initial admission when timing rules differ; render deadlines and gates from the actual policy engine.

### 2.3 Layout

Desktop: compact header with patient/referral identity and status; horizontal progress tracker; central task content; optional right-side “Needs attention” panel; fixed, accessible primary action. Source document and extraction form may use a resizable two-pane view. Mobile/tablet: single column, sticky next action, document viewer opened as a dedicated view; no horizontal overflow.

Only one prominent action per stage: e.g. **Review extracted information**, **Resolve possible duplicate**, **Continue to admission requirements**. Secondary actions: Save and exit, Assign, View history, Download original, Close referral (permission-dependent). Every button must have a real, authorized handler.

### 2.4 Design rules

- Use existing **Lantern**/ChartWarden design tokens and shared components **if confirmed in checkout**. No purple gradients, arbitrary new brand colors, decorative AI imagery, or custom one-off UI primitives where a shared component exists.
- Plain-language headings and concise instructions. No technical state machine jargon in patient-facing or frontline UI.
- WCAG 2.2 AA target: semantic landmarks, visible keyboard focus, accessible validation summaries, screen-reader progress announcements, logical tab order, sufficient contrast, and large enough touch targets.
- Distinguish warning, blocked, pending, and complete by **text + icon**, not color alone.
- Show autosave state only if autosave is genuinely implemented; otherwise provide explicit Save with unsaved-change protection.
- No real PHI in screenshots, test snapshots, telemetry, or issue descriptions.

## 3. Workflow and data safety contracts

**Authoritative state:** Server owns clinical eligibility, admission readiness, conversion, and compliance decisions. UI may summarize them but must not bypass or duplicate them as a second source of truth.

**Field provenance:** For extracted values, retain source document/page or location when supported, extraction method, review decision, reviewer, timestamp, and previous value as allowed by current schema. If these are not supported, log a backend dependency and obtain approval; do not fabricate provenance.

**Conflict handling:** Contradictory medication lists, demographics, allergies, or physician details must be flagged for manual reconciliation. Do not auto-merge clinical records. A document marked “processed” is not the same as “verified.”

**Tenant and permissions:** Every read/write must use existing tenant-scoped APIs and authorization rules. Never trust a tenant ID or patient ID from the browser alone. Protect cross-tenant document URLs and presigned access.

**Idempotency and navigation:** Refresh, retry, double click, back navigation, interrupted upload, and repeated conversion requests must not create duplicate patients, admissions, or documents. Use existing idempotency semantics; escalate gaps rather than masking them in UI.

**Audit:** Preserve or add, with approval, auditable events for referral assignment, field verification/edit/rejection, patient match decisions, document review, admission conversion, and any overrides. No raw PHI in logs or analytics.

**Security:** Scan uploads as required by current platform controls; validate file type/size, enforce authorization, isolate storage by tenant, and prevent unsafe preview/download. AI services must not receive PHI without approved processing terms and deployment controls.

## 4. Engineering work packages

### WP0 — Audit and contract mapping (required)

- Deliver current-state audit, route/state maps, feature inventory, and preservation matrix.
- Create before/after journey diagram with exact navigation transitions.
- Identify existing backend APIs for every proposed step; classify each UI action as `reuse`, `adapt`, `requires approval`, or `not supported`.
- **Acceptance:** No unsupported API assumptions; reviewers can trace every action to a real handler or an explicitly blocked dependency.

### WP1 — Intake worklist

- Reorganize existing referral listing into action-oriented queues with meaningful counts, ownership, search, and filters.
- Add one primary New intake entry point; keep existing deep links functional.
- Map all current statuses to display labels without data migration.
- **Acceptance:** Every referral has a discoverable next action or explicit reason it cannot advance; no state is hidden by a filter or label mapping.

### WP2 — Shared Intake Workspace shell

- Add a route-compatible workspace shell around existing screens/components, preserving bookmarks and history.
- Implement stepper, patient/referral header, blocker summary, ownership, and one stage-specific CTA.
- Use existing route loaders, mutations, query/cache utilities, auth, and error handling.
- **Acceptance:** Refresh/back/forward retain correct state; no new source of truth; keyboard navigation and responsive layout pass checks.

### WP3 — Document-first referral capture

- Integrate existing upload/document handling into step 1; support manual entry when documents are absent or extraction fails.
- Display upload, processing, extraction-ready, review-needed, and failure states distinctly.
- Preserve original documents and existing access controls.
- **Acceptance:** Upload failure/retry never loses prior data or creates duplicate documents; manual fallback is usable.

### WP4 — Verified extraction review

- Reuse existing DocLens or equivalent **only if confirmed**. Embed or link it in a way that returns users to the same intake context.
- Support source/field comparison, accept/edit/reject, conflicts, reviewer ownership, and explicit verification completion.
- If field-level provenance or review APIs are absent, stop at a documented integration boundary and seek approval for backend changes.
- **Acceptance:** Unreviewed extraction cannot silently populate verified clinical fields; rejected/conflicting data remains visibly unresolved.

### WP5 — Patient matching and referral conversion

- Reuse current patient matching; make candidate selection and reasons visible; require explicit confirmation.
- Show conversion summary and server-reported blockers before creating an admission.
- **Acceptance:** Duplicate-match scenarios, unauthorized conversion, and repeated submissions are safely handled; backend gates still apply.

### WP6 — Admission readiness and handoff

- Consolidate relevant existing election, CTI, assessment, coverage, signatures, and admission tasks into grouped sections.
- Render server-derived readiness and time-sensitive deadlines. Each blocker links directly to the corrective task.
- Preserve legally significant signatures and clinical attestations; do not mark them complete via frontend toggles.
- **Acceptance:** All previously enforced blockers remain enforced; a user can see blocker, reason, owner, and next action without leaving the workspace unnecessarily.

### WP7 — Cleanup, migration of navigation, and documentation

- Remove or redirect **only redundant UI navigation**, never delete domain logic without dependency analysis.
- Maintain compatibility for existing bookmarks, permissions, and in-flight referrals.
- Add user-facing workflow guidance and internal support documentation.
- **Acceptance:** Old deep links resolve; no orphan routes, inaccessible features, or broken back navigation.

## 5. Testing matrix (mandatory)

Use fictional patient data only. At minimum, automate where infrastructure allows:

| Scenario                                    | Required assertion                                                  |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Complete referral packet                    | Review → match → admission handoff follows permitted backend path |
| Manual referral, no documents               | Intake can proceed through supported manual workflow                |
| Extraction unavailable or low confidence    | Visible error/uncertainty; manual review remains available          |
| Conflicting medication/allergy values       | Explicit reconciliation required; no silent overwrite               |
| Possible duplicate patient                  | Match decision required; no duplicate created inadvertently         |
| Missing required admission document         | Server blocks restricted transition; UI explains why                |
| Incomplete election/CTI/signature           | Existing legal and clinical gates remain intact                     |
| Cross-tenant record/document access         | Denied at API and UI; no PHI leakage                                |
| User lacks permission                       | Action hidden/disabled appropriately and API rejects mutation       |
| Upload interruption/retry                   | No duplicate file; recoverable user state                           |
| Double-click conversion                     | At most one admission created                                       |
| Stale tab or concurrent reviewer            | Conflict is surfaced; no silent lost update                         |
| Browser back/refresh/deep link              | Correct current state and stage restored                            |
| Small screen, zoom, keyboard, screen reader | Usable navigation, focus, labels, and errors                        |
| Audit verification                          | Clinical decisions and transitions produce expected events          |

**Verification commands:** Discover actual scripts from `package.json`/workspace configuration. Run relevant format/lint (including Biome if configured), typecheck, unit/component tests, API contract tests, and E2E tests. Record exact commands and exit codes; do not claim tests passed if blocked. Do not require production credentials or real PHI.

## 6. Delivery sequencing and gates

1. **PR 1 — Audit + UX specification only.** Gate G0 approval required.
2. **PR 2 — Worklist and shared shell.** No backend changes. Gate G1: route/permission parity, visual review.
3. **PR 3 — Document capture and review integration.** Gate G2: provenance, conflict, retry, and security tests.
4. **PR 4 — Patient matching and admission handoff.** Gate G3: duplicate/idempotency and server readiness tests.
5. **PR 5 — Admission readiness consolidation + accessibility + rollout.** Gate G4: end-to-end scenarios and user acceptance.

Each PR should include screenshots of desktop/tablet/mobile using synthetic data, a change inventory, known limitations, test evidence, and rollback instructions. Feature-flag the new workspace if the current app supports flags; otherwise use a reversible route-level rollout. Do not change the production default until approved.

## 7. Definition of done

- Staff can initiate and progress a referral from one obvious intake entry point.
- Each stage shows one clear next action and any blockers with reasons and ownership.
- Existing authorization, tenant isolation, audit, clinical validation, and admission state transitions are preserved.
- AI-derived data is explicitly reviewed and does not masquerade as verified facts.
- Existing deep links and in-progress referrals continue to work.
- Automated tests cover high-risk transitions and failure cases; accessibility and responsive behavior are verified.
- No unapproved backend contract changes, no undocumented new clinical rules, and no PHI in fixtures or screenshots.
- A non-developer hospice intake staff member can complete representative scenarios in usability testing without needing to know the app's internal architecture.

## 8. Claude Code execution instructions

**Start by reading this plan and the current repository; do not start coding immediately.**

1. Inspect repository structure, AGENTS.md/CLAUDE.md instructions, package scripts, routing, UI tokens, and relevant clinical services.
2. Produce the audit and an implementation diff map, citing concrete files and line numbers.
3. Identify discrepancies between this plan and repository reality. Prefer existing domain behavior and surface any compliance or API uncertainty for approval.
4. Implement **one work package at a time** on a dedicated branch, with small reviewable commits. Do not alter unrelated modules or the Rust migration project.
5. Run tests after each work package. Report exact pass/fail/block status and remaining risks.
6. Never bypass a server-side gate to make the new UI appear complete.
7. Stop and ask for approval before schema changes, new external PHI integrations, changes to clinical eligibility rules, signature logic, Medicare notice behavior, or irreversible admission transitions.
8. End each PR with: files changed, user-visible behavior, backend impact, test commands/results, security and compliance considerations, migration/rollback, and open issues.

**First requested output from Claude Code:** `docs/implementation/intake-current-state-audit.md` plus a proposed PR-by-PR file map. **Do not implement PR 2 until Gate G0 is approved.**
