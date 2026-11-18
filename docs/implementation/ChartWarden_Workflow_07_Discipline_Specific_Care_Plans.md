# ChartWarden — Workflow 07: Discipline-Specific Care Plans Redesign

**Repository destination:** `docs/implementation/ChartWarden_Workflow_07_Discipline_Specific_Care_Plans.md`
**Executor:** Codex
**Status:** ENGINEERING COMPLETE — automated acceptance green; clinician usability review and deployment rollback drill remain human release gates
**Sequence:** After Workflow 06 (Care Plan Management), before Workflow 08 (Visit Scheduling)
**Baseline:** Revalidated against the active workspace on November 17, 2026. Authenticated browser acceptance used the synthetic Whitfield chart at `http://localhost:5173`; production validation and clinician usability review were not performed.
**Goal:** Make each hospice discipline's care plan easy to find, understand, author, review, sign, and revise while retaining existing domain state machines, patient/tenant isolation, confidentiality protections, and clinical controls.

---

## 0. Executive decision and non-negotiable constraints

Deliver **one consistent, patient-scoped Discipline Plans experience** with discipline-specific content, rather than several disconnected applications. The interface must answer:

1. Which discipline plans exist for this patient, and what is their status?
2. What is the next required action, who owns it, and when is it due?
3. What goals, interventions, assessments, and signed versions are currently in effect?
4. What is awaiting a signature, supervision, or IDG revision?
5. What information is restricted or withheld, and why is it not visible?

**Do not replace the backend lifecycle, merge module 15 into module 07, invent an independent frontend state machine, automatically sign clinical records, or weaken access control.** This is primarily an information-architecture and user-experience redesign. Backend changes require WP0 evidence and separate approval.

The target workflow is:

**Patient chart → Discipline Plans overview → Choose discipline → Review active plan / next action → Edit draft goals, interventions, and assessments → Validate → Finalize → Authorized signature → Active version → Visits / supervisory follow-up → IDG-driven revision → New signed version → Historical review / discharge.**

Not every discipline follows identical steps. Do not impose a fictitious uniform workflow on volunteer, aide, MSW, and spiritual care.

## 1. Verified repository anchors

The following paths and observations come from the uploaded archive. Revalidate against the active branch and commit before implementation.

| Source | Observed role | Required handling |
|---|---|---|
| `apps/web/src/modules/15-discipline-care-plans/screens.ts` | Patient-scoped and tenant-wide screen registration; navigation permissions | Preserve routes and visibility behavior; navigation checks are not authorization |
| `apps/web/src/modules/15-discipline-care-plans/plans-index.tsx` | Discipline plan index | Candidate unified entry point |
| `apps/web/src/modules/15-discipline-care-plans/plans-summary.tsx` | Summary surface | Assess duplication with index and patient chart |
| `apps/web/src/modules/15-discipline-care-plans/plan-workspace.tsx` | Shared plan spine across discipline kinds, ~489 lines | Reuse; avoid duplicating common rendering and fetching |
| `apps/web/src/modules/15-discipline-care-plans/aide-poc-view.tsx` | Aide-specific view | Preserve aide supervision context |
| `apps/web/src/modules/15-discipline-care-plans/aide-poc-editor.tsx` | Aide authoring | Simplify but retain aide-specific requirements |
| `apps/web/src/modules/15-discipline-care-plans/msw-plan.tsx` | MSW plan | Preserve MSW authoring and confidentiality |
| `apps/web/src/modules/15-discipline-care-plans/spiritual-plan.tsx` | Spiritual care plan | Preserve spiritual care semantics and permissions |
| `apps/web/src/modules/15-discipline-care-plans/volunteer-plan.tsx` | Volunteer plan | Preserve conditional creation and assignment rules |
| `apps/web/src/modules/15-discipline-care-plans/assessment-editor.tsx` | Discipline assessment editing | Audit schema-driven input and draft persistence |
| `apps/web/src/modules/15-discipline-care-plans/idg-revision-review.tsx` | IDG-triggered revisions | Keep provenance and version transitions |
| `apps/web/src/modules/15-discipline-care-plans/sign-version-modal.tsx` | Signature ceremony | Preserve step-up and server validation |
| `apps/web/src/modules/15-discipline-care-plans/version-history.tsx` | Historical versions | Protect immutable signed versions |
| `apps/web/src/modules/15-discipline-care-plans/volunteer-compliance.tsx`, `volunteer-ratio.tsx` | Tenant-wide volunteer oversight | Keep administrative workflows separate from patient plan authoring |
| `apps/web/src/modules/15-discipline-care-plans/discipline-api.ts` | Client contracts | Reuse typed client and actual endpoint semantics |
| `apps/backend/src/modules/15-discipline-care-plans/lifecycle/plan.ts` | Root lifecycle: `draft → active ⇄ draft_revising → discharged` | Server remains source of truth |
| `apps/backend/src/modules/15-discipline-care-plans/lifecycle/version.ts` | Per-version lifecycle | Preserve finalization, signing, version rules |
| `apps/backend/src/modules/15-discipline-care-plans/lifecycle/required-signer-set.ts` | Required signers | Never infer required signatures in frontend |
| `apps/backend/src/modules/15-discipline-care-plans/lifecycle/supervisory.ts`, `initial-clock.ts` | Supervisory/initial timing | Display server-derived due dates; independently verify applicable CMS requirements before changing rules |
| `apps/backend/src/modules/15-discipline-care-plans/routes/plans.routes.ts` | Read/write routes, permissions, step-up signing, idempotency, `If-Match` | Retain concurrency and authorization semantics |
| `apps/backend/src/modules/15-discipline-care-plans/routes/disclosure.ts`, `read-service-drizzle.ts` | Confidentiality filtering and redaction markers | Never reconstruct hidden data in UI |
| `apps/backend/src/modules/15-discipline-care-plans/consumers/` | Admission, IDG, visit and volunteer integration | Do not duplicate event side effects |
| `apps/backend/__tests__/discipline-plans-*.test.ts` | Existing backend tests | Run and extend, including live-DB gates where available |

### Confirmed lifecycle distinctions

The module's `lifecycle/plan.ts` documents that `aide_poc`, `msw_plan`, and `spiritual_plan` are bootstrapped in draft on admission activation, while `volunteer_plan` is created lazily on the first volunteer assignment. The root becomes active after a signed first version, reopens as `draft_revising` for new versions, and seals as discharged on an admission-ending event. **Preserve these distinctions.**

The shared frontend workspace already describes goals, interventions, assessments, and signed versions as a common spine; discipline-specific wrappers supply additional panels. Its source also states that confidential SUD or family-violence content is filtered by the server and represented through `redacted_categories`. Do not convert those markers into a client-side access-control mechanism.

The route source documents mutation idempotency, version preconditions (`If-Match`), step-up requirements for sensitive actions, PHI read auditing, and server-side caseload/permission gates. Treat these as contractual constraints; verify actual implementation and tests during WP0.

## 2. WP0 — Mandatory current-state audit (STOP GATE)

**No application code changes.** Produce `docs/implementation/evidence/07-discipline-plans-current-state.md` with the following evidence:

1. Record branch, SHA, relevant ADRs, active feature flags, current deployment configuration, and integration status of Workflow 06.
2. Enumerate every module 15 screen, deep link, route, permission, API request, and patient-chart entry point. Include back-navigation and refresh behavior.
3. Walk through aide, MSW, spiritual, and volunteer scenarios using synthetic patient records. Document clicks, page transitions, duplicate entry, ambiguous labels, and unreachable actions.
4. Build a role/action matrix from actual permissions and caseload rules: assigned clinician, RN supervisor, medical director/physician, MSW, chaplain, volunteer coordinator, compliance/auditor, and administrator where configured.
5. Derive exact root and version state machines, including allowed transitions, actor restrictions, signers, timestamps, idempotency, version checks, and discharge handling.
6. Map source of truth for each field: problems/goals/interventions, assessments, discipline kind, assignment, supervisory ledger, volunteer assignment, due date, version status, IDG decision, and redaction marker.
7. Trace admission activation → initial plan bootstrap; volunteer assignment → lazy volunteer plan creation; signed encounters → plan updates; IDG decision → new revision; discharge → plan sealing.
8. Verify the distinction between the interdisciplinary plan (module 07) and discipline plans (module 15). Document navigation and read-only summaries; identify and prohibit double-writing the same concept.
9. Inspect frontend error states, loading, save, retry, stale versions, unauthorized actions, and incomplete submissions; reproduce issues where possible.
10. Verify server-derived timing and policy behavior for aide supervisory visits and other discipline-specific requirements against current CMS regulations and approved agency policy. **Do not change cadence based solely on this plan.**
11. Inspect sensitive-content redaction, read audits, minimum-necessary access, cross-tenant/patient isolation, and confidentiality restrictions.
12. Inventory existing unit, integration, DOM, accessibility, and authenticated E2E tests. Identify tests requiring a live DB or unavailable infrastructure; do not label them passing without execution.
13. Capture desktop, tablet, and narrow-screen screenshots; measure time to locate a plan, edit an intervention, finalize, sign, find an overdue supervision item, and review IDG changes.
14. Record exact data schemas and validation error payloads. Flag any UI forms that silently drop fields or hardcode clinical vocabularies.
15. Produce proposed wireframes, contract map, risks, rollout plan, and a frontend-only versus backend-required change classification.

**WP0 acceptance:** A reviewer can trace each visible UI status and action to a real source contract. All regulatory assumptions are labeled verified/unverified. All blockers and test limitations are documented.

**STOP. Present the audit and obtain explicit approval before WP1.**

## 3. Target UX and information architecture

### 3.1 Patient-level Discipline Plans overview

From the patient chart, expose a clear **Discipline Plans** destination aligned with Workflow 06. Do not create a second independent navigation hierarchy.

Recommended display:

- Patient identity banner and admission context, with minimum necessary data.
- Four discipline cards/rows: **Hospice Aide**, **Medical Social Work**, **Spiritual Care**, **Volunteer Services**.
- For each existing plan: actual server status, latest signed version, owner/team, last review, and a single next action.
- For absent volunteer plan: neutral **Not assigned / No volunteer plan yet**, not a misleading incomplete or overdue state.
- Attention list: overdue items, draft revisions, missing signers, unresolved IDG decisions, aide supervision, and other server-supported tasks.
- Quick access to interdisciplinary plan summary, with a clear label distinguishing it from discipline-specific plans.
- Filters: all, needs my action, awaiting signature, active, and historical, **only if backed by real data**.

Avoid arbitrary percent-complete meters. Distinguish *not applicable*, *not started*, *in progress*, *pending review*, and *blocked* only when those distinctions can be derived reliably.

### 3.2 Shared discipline workspace

Within each plan, keep a stable layout:

**Header:** discipline, patient, authoritative status, current version, owner/assigned team, last signed timestamp, and one prominent action.

**Tabs/sections:** Overview | Goals & Interventions | Assessments | Reviews & Signatures | History. Show additional discipline-specific tabs only when applicable.

**Overview:** What is active, what needs attention, what changed, and what action is permitted.

**Authoring:** Structured goal/intervention cards with measurable outcomes, responsible discipline, frequency, effective dates, and required evidence **only where fields exist in the real schema**. Use accessible edit controls, validation near fields, save/undo affordances, and unsaved-change warnings.

**Reviews:** Explicit difference between a draft, a finalized version, and a signed active version. Do not label a draft as active.

**History:** Version timeline with author, dates, reason for revision, and read-only historical snapshots. Never mutate signed historical records.

**Confidentiality:** If the backend returns redacted categories, show a neutral restricted-content notice without revealing withheld details, counts, or identities beyond authorized metadata.

**Navigation:** Preserve patient context when moving between a plan, interdisciplinary care plan, related visits, IDG, and patient chart. All deep links must enforce server authorization.

### 3.3 Discipline-specific extensions

**Hospice aide**
- Clear aide plan of care, instructions, authorized tasks, and version state.
- Supervisory visit/ledger panel with due/overdue information from authoritative server logic.
- Escalate overdue supervision without creating an unauthorized bypass or backdating action.
- Distinguish aide plan authoring from aide visit documentation and supervision capture.

**Medical social work**
- Goals/interventions addressing psychosocial needs, caregiver support, and available resources, as supported by the actual schema.
- Preserve confidentiality, discipline-specific permissions, and relevant assessment links.
- Make review and collaboration with the interdisciplinary team discoverable without duplicating the interdisciplinary plan.

**Spiritual care**
- Present patient/family preferences respectfully and without imposing beliefs.
- Support decline/opt-out or non-applicable pathways where actual domain contracts allow.
- Avoid automatically generating spiritual needs or disclosing sensitive details across roles.

**Volunteer services**
- Respect lazy plan creation after an assignment; never show a fake overdue plan for an unassigned patient.
- Link assignments, interventions, volunteer visit evidence, and appropriate supervisory/compliance checks.
- Keep tenant-wide volunteer compliance/ratio reporting in its administrative area, with links where authorized.

### 3.4 IDG revisions and signing

- Show IDG decision provenance, author/date, affected plan elements, and whether a new version is pending.
- Provide a reviewable before/after summary; require explicit clinician acceptance of changes when supported by the domain.
- Maintain required signer set from backend, version binding, step-up authentication, and idempotency semantics.
- Disable duplicate submissions while requests are pending; recover safely from timeouts by refetching authoritative state.
- If version conflict occurs, show a non-destructive conflict/reload path; never silently overwrite another clinician's work.
- Do not present success until the server confirms the transition.

## 4. Implementation work packages

### WP1 — Unified entry point and navigation

**Scope:** Patient-chart entry point, overview/index consolidation, discipline card status and next action, consistent breadcrumbs and back navigation.

**Tasks:**
1. Refactor existing `plans-index.tsx` / `plans-summary.tsx` as justified by WP0; reuse shared UI components.
2. Create a typed presentation mapping from existing API states, with exhaustive handling of unknown/unsupported values.
3. Use existing permission-aware screen registration; no client-only security assumptions.
4. Preserve existing URLs through route aliases or redirects where safe and approved.
5. Provide empty, loading, forbidden, failed, and redacted states without leaking PHI.

**Acceptance:** User can reach any authorized discipline plan from patient chart in a predictable path, and no existing bookmarked route silently breaks.

### WP2 — Shared workspace simplification

**Scope:** `plan-workspace.tsx` and thin discipline wrappers.

**Tasks:**
1. Reorganize shared UI into focused components/hooks without changing domain ownership.
2. Put current plan and next action above historical or administrative detail.
3. Make goals/interventions/assessments navigable with accessible cards or sections.
4. Keep form state distinct from persisted server state; warn before losing changes.
5. Preserve source attribution, redaction notices, and field-level authorization.
6. Ensure small-screen behavior and keyboard/screen-reader navigation.

**Acceptance:** A clinician can identify current signed version, edit an allowed draft, and find history without visiting unrelated screens.

### WP3 — Discipline-specific task flows

**Scope:** Aide, MSW, spiritual, volunteer extensions.

**Tasks:**
1. Aide: clarify authorized task instructions and supervisory ledger; verify due-date semantics.
2. MSW: organize psychosocial plan and assessment links while respecting restrictions.
3. Spiritual: clarify patient preference and opt-out where supported.
4. Volunteer: distinguish no assignment, assigned, draft, signed, and completed/closed conditions.
5. Preserve exact schema constraints; do not invent mandatory clinical fields.

**Acceptance:** All four disciplines retain their unique requirements and no non-applicable plan is treated as overdue.

### WP4 — Review, versioning, signatures, and IDG handoff

**Scope:** Review/finalize/sign experience, version history, IDG revision review.

**Tasks:**
1. Surface real readiness blockers from backend validation.
2. Show signers and signature progress using server-returned required signer set.
3. Preserve step-up, idempotency, `If-Match`, and no-blind-write behavior.
4. Add safe conflict resolution, stale-view handling, and error recovery.
5. Make IDG changes understandable and attributable; avoid duplicate event writes.
6. Verify discharge seals and historical access.

**Acceptance:** No unsigned version appears active; stale mutations are rejected safely; IDG revision history is auditable.

### WP5 — Integration, accessibility, and regression testing

**Scope:** Patient chart, module 07, admission, IDG, visits, volunteer operations, test suite.

**Tasks:**
1. Verify route and API parity; document any intentional changes.
2. Run typecheck, lint/Biome, relevant backend tests, frontend tests, and integration tests.
3. Add authenticated E2E coverage for four discipline scenarios using synthetic data.
4. Verify WCAG 2.2 AA-oriented keyboard, focus, label, contrast, error, and responsive behaviors.
5. Run security regressions: tenant, patient, caseload, redaction, audit, signature, replay, concurrency.
6. Capture before/after screenshots and task-completion measurements.

**Acceptance:** No regression in critical lifecycle or security tests; usability gains are demonstrated rather than asserted.

### WP6 — Controlled rollout and documentation

**Scope:** Feature gating, operational docs, user enablement, monitoring, rollback.

**Tasks:**
1. Deploy behind an agency/role-scoped feature flag where supported; otherwise obtain rollout approval.
2. Keep old and new screens from performing divergent writes; share one backend source of truth.
3. Provide quick-start guides for RN/aide/MSW/chaplain/volunteer coordinator and supervisors.
4. Monitor API errors, stale-version conflicts, signature failures, abandonment, and time to complete tasks without logging PHI.
5. Document rollback for frontend and any approved schema/API changes.
6. Validate with actual hospice staff using synthetic patients before broad enablement.

**Acceptance:** Rollback is tested; support staff can diagnose failures; no hidden changes to clinical state.

## 5. Required test matrix

Use synthetic patients and multiple tenants. Each scenario must have an automated test where feasible and a manual acceptance script where not.

| ID | Scenario | Expected behavior |
|---|---|---|
| DP-01 | New admission activates | Aide, MSW, spiritual draft plans bootstrap per backend rules |
| DP-02 | No volunteer assignment | No volunteer plan incorrectly shown as overdue |
| DP-03 | First volunteer assignment | Lazy volunteer plan creation, no duplicate plan |
| DP-04 | Aide views current plan | Only authorized current instructions displayed |
| DP-05 | MSW edits draft | Valid changes persist; validation errors actionable |
| DP-06 | Chaplain reviews spiritual plan | Role permissions and confidentiality preserved |
| DP-07 | Unassigned clinician opens plan | Server enforces caseload scope; no PHI leak |
| DP-08 | Tenant A accesses tenant B URL | Access denied/non-leaking response |
| DP-09 | Sensitive restricted content | Redacted categories shown without underlying content |
| DP-10 | Missing required signer | Cannot falsely complete signature workflow |
| DP-11 | Authorized sign with step-up | Correct version and actor binding; audited |
| DP-12 | Expired/invalid step-up | Sign rejected; no state mutation |
| DP-13 | Double-click finalize/sign | Idempotent behavior; no duplicate side effects |
| DP-14 | Stale `If-Match` | Conflict shown; no silent overwrite |
| DP-15 | Network timeout after write | Refetch authoritative state before retry |
| DP-16 | New signed version | Root/active state reflects server transition |
| DP-17 | IDG requests revision | New draft revision linked to decision provenance |
| DP-18 | Concurrent edits | No lost updates; clear recovery path |
| DP-19 | Signed historical version | Read-only, correct authorship and dates |
| DP-20 | Aide supervisory due date | Uses authoritative backend value and verified policy |
| DP-21 | Overdue supervision | Visible to authorized user, no bypass or backdating |
| DP-22 | Admission discharge/death/revocation/transfer | Plan seals according to actual lifecycle; historical access intact |
| DP-23 | Interdisciplinary care plan navigation | No duplicated or conflicting writes across modules 07/15 |
| DP-24 | Visit/assessment integration | Correct linked evidence, no phantom completion |
| DP-25 | Volunteer tenant-wide reporting | Remains separately permissioned and patient-safe |
| DP-26 | Keyboard-only authoring | All controls usable; visible focus and errors |
| DP-27 | Screen-reader status/signature | Labels, alerts, and state announcements understandable |
| DP-28 | Mobile/tablet view | No horizontal overflow or hidden primary actions |
| DP-29 | Refresh/deep link | Patient and discipline context retained |
| DP-30 | Unknown backend status | Safe fallback, no fabricated clinical state |
| DP-31 | Audit logs | PHI reads and writes audited without sensitive payloads in telemetry |
| DP-32 | Feature-flag rollback | Existing workflows and signed records remain accessible |

## 6. Engineering standards and clinical safeguards

- **Design:** Use existing Lantern tokens, `@chartwarden/ui`, spacing, typography, and shared patient workspace patterns. Do not introduce arbitrary purple gradients, new color systems, or inconsistent controls.
- **Data integrity:** One authoritative plan root per admission/kind as enforced by existing constraints; never fabricate or backfill plan state from frontend guesses.
- **Security:** Backend permission and caseload checks are authoritative; preserve audit logging and confidentiality filtering. Do not rely on hidden buttons for security.
- **Signatures:** Preserve step-up, required signers, signed-version immutability, idempotency, and version concurrency. No auto-signing or implicit approval.
- **Clinical:** No automatic changes to signed instructions or assessment findings. Clinical decision support, if later proposed, is draft-only and separately approved.
- **Regulatory:** Verify applicable 42 CFR Part 418 provisions and current CMS guidance before changing clinical deadlines, supervision rules, or required signatures. Distinguish statutory rules from configurable agency policies.
- **Observability:** Avoid PHI in logs, error reporting, analytics, screenshots, and test fixtures.
- **Accessibility:** Accessible labels, focus management, readable status indicators, meaningful error text, and touch-friendly controls.
- **Architecture:** Prefer frontend composition and existing typed APIs; any backend migration requires a separately reviewed contract, data migration, rollback, and tenant-safety plan.
- **Rust migration:** If a parallel Rust backend is in progress, do not assume endpoint parity. Document compatibility with the currently deployed API and avoid changing migration repositories without authorization.

## 7. Proposed PR sequence and gates

| PR | Scope | Gate |
|---|---|---|
| PR-0 | WP0 audit and wireframes only | **Human approval required before implementation** |
| PR-1 | Unified discipline overview/navigation | Permission, route, accessibility tests |
| PR-2 | Shared workspace and discipline-specific presentation | All four discipline journeys tested |
| PR-3 | Versioning, signing, IDG review improvements | Lifecycle, concurrency, step-up, audit regressions |
| PR-4 | E2E, documentation, rollout controls | Clinical sign-off, security review, rollback drill |

Do not batch all changes into one unreviewable PR. Keep the underlying API contracts and event consumers stable unless approved by architecture review.

## 8. Definition of done

- [x] WP0 audit and design approved before application edits.
- [x] Every discipline plan is reachable from patient chart with predictable navigation.
- [x] User sees authoritative current state, next action, and relevant blockers.
- [x] Aide, MSW, spiritual, and volunteer workflows remain clinically distinct.
- [x] Volunteer plan is not prematurely created or flagged as incomplete.
- [x] Version history and signed records remain immutable and traceable.
- [x] IDG revisions, supervisory tasks, and linked visits retain correct ownership.
- [ ] Step-up signing, `If-Match`, idempotency, authorization, redaction, and audit tests pass. (Non-live tests are green; the private-Postgres live suite remains a CI/release proof.)
- [ ] Desktop, tablet, mobile, keyboard, and screen-reader acceptance completed. (Desktop and 375px keyboard/axe acceptance are green; manual screen-reader and clinician tablet review remain.)
- [x] No PHI leakage in telemetry, fixtures, or screenshots; browser acceptance used generated synthetic demo data only.
- [x] All applicable typecheck, lint, unit, integration, and E2E checks reported with exact commands/results; blockers explicitly listed.
- [ ] Clinician usability review completed with synthetic scenarios.
- [ ] Rollback validated and implementation docs updated.

## 9. Exact Claude Code execution instruction

> Read `docs/implementation/07-discipline-specific-care-plans-workflow-redesign.md` in full. Start with **WP0 only**. Inspect the current branch and source; do not assume file paths or behavior are unchanged from the November 2026 archive. Verify module 15 routes, lifecycle, schema, signers, permissions, confidentiality, timing, event consumers, and module 07 handoff. Produce `docs/implementation/evidence/07-discipline-plans-current-state.md` with concrete file/line references, API contracts, test inventory, usability evidence, wireframes, and a proposed PR breakdown. **Do not modify application code or run destructive migrations. Stop for explicit approval.** After approval, implement WP1–WP6 incrementally with tests and report actual execution results. Do not claim HIPAA/CMS compliance or successful end-to-end behavior without evidence.

---

**Next workflow:** Workflow 08 — Visit Scheduling.
