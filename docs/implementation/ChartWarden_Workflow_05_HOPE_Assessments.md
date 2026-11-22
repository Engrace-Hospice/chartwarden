# ChartWarden — Workflow 05: HOPE Assessments UX and Workflow Redesign

**Repository destination:** `docs/implementation/05-hope-assessments-workflow-redesign.md`
**Executor:** Claude Code
**Status:** Proposed; **audit and approval required before product-code changes**
**Sequence:** After Workflow 04 (Initial Assessments); before Workflow 06 (Care Plan Management)
**Baseline:** Static inspection of the uploaded `chartwarden-main.zip` on November 14, 2026. No live application, database, authenticated browser workflow, or deployed iQIES integration was tested.
**Scope:** HOPE timepoint tracking, capture, validation, signature, symptom follow-up visits (SFV), submission readiness, iQIES submission visibility, corrections, and operational monitoring.
**Out of scope:** Replacing the HOPE domain engine, inventing CMS data specifications, silently changing timepoint clocks, or merging HOPE with general initial assessments.

## 0. Executive decision

Create a **single, patient-scoped HOPE Workspace** with clear progression:

**Patient chart → HOPE → Timepoint / task → Complete guided sections → Resolve validation issues → Sign → Package / submit → Track CMS outcome.**

The clinician must always know: **(1)** which HOPE timepoint applies, **(2)** when action is due and which event anchors the clock, **(3)** what remains incomplete, **(4)** what action is authorized next, and **(5)** whether the record is only saved, signed, packaged, transmitted, accepted, or rejected. These are distinct states.

Preserve existing server-side eligibility, timing, required-item, validation, signature, and submission controls. **UI simplification is not regulatory simplification.**

## 1. Evidence from the uploaded repository

These paths and observations are **static source anchors**, not verified claims of end-to-end production operation. Claude must recheck every path on the target branch.

| Path | Observed responsibility / evidence | Redesign implication |
|---|---|---|
| `apps/web/src/modules/10-hope/hope-dashboard.tsx` | ~509 lines; organizational HOPE dashboard and status summaries | Keep operational oversight distinct from patient task completion |
| `apps/web/src/modules/10-hope/patient-hope-timeline.tsx` | ~284 lines; patient chronology covering Admission, HUV1, HUV2, SFV, Discharge | Use as the entry point into one patient workspace |
| `apps/web/src/modules/10-hope/hope-capture-workspace.tsx` | ~528 lines; patient HOPE capture with timepoint and draft handling | Consolidate capture and validation into guided task flow |
| `apps/web/src/modules/10-hope/hope-assessment-detail.tsx` | HOPE assessment detail screen | Preserve signed and historical read-only access |
| `apps/web/src/modules/10-hope/hope-record-modal.tsx` and `hope-action-modal.tsx` | HOPE recording and action surfaces | Audit overlapping modal/page flows and eliminate unnecessary context switches |
| `apps/web/src/modules/10-hope/admission-hope-overview.tsx` | Admission-linked HOPE overview | Reuse within the patient workspace; do not create a second timepoint engine |
| `apps/web/src/modules/10-hope/sfv-worklist.tsx` | Dedicated symptom follow-up worklist | Surface SFV obligations directly in patient and team task views |
| `apps/web/src/modules/10-hope/submission-worklist.tsx`, `submission-detail.tsx`, `iqies-submission-panel.tsx` | Submission packaging, tracking, and patient-record links | Keep packaging/transmission/CMS result states explicit |
| `apps/web/src/modules/10-hope/record-cms-result-modal.tsx`, `cms-result-parser.ts` | CMS result recording/parsing surfaces | Validate whether external results are automated, manual, or both before changing labels |
| `apps/web/src/modules/10-hope/hqrp-compliance-dashboard.tsx` | HQRP operational dashboard | Preserve agency-level reporting separate from clinician tasks |
| `apps/web/src/modules/10-hope/hope-chart-reconcile.tsx` | Chart reconciliation UI | Clarify provenance and conflict resolution, not silent overwrite |
| `apps/web/src/modules/10-hope/screens.ts` | Screen registration and permission-based visibility; comments inventory HOPE screens | Audit actual navigation and role permissions |
| `apps/backend/src/modules/10-hope/routes/hope-routes.ts` | ~741 lines; routes use authorization and server-side org binding | Do not bypass RBAC, ABAC, tenant isolation, or API contracts |
| `apps/backend/src/modules/10-hope/hope-readiness-service.ts` | ~616 lines; readiness and required-item logic | Readiness must remain server-authoritative |
| `apps/backend/src/modules/10-hope/hope-answer-service.ts`, `hope-validation-service.ts`, `spec/` | Answer capture, validation and versioned applicability rules | Render authoritative requirements; never hardcode CMS item logic in UI |
| `apps/backend/src/modules/10-hope/hope-sfv-service.ts` | Symptom follow-up logic | Preserve event/date anchors and clinical trigger rules |
| `apps/backend/src/modules/10-hope/hope-cms-xml-render.ts`, `hope-cms-xml-serializer.ts`, `jobs/submission.ts` | CMS payload generation and submission-related jobs | Preserve serialization, idempotency, and submission evidence |
| `apps/backend/src/modules/10-hope/outbox-consumers/` and `scheduling/` | Admission/discharge event handling and scheduling | Avoid new duplicate scheduling mechanisms |
| `apps/backend/src/modules/10-hope/spec/v1_00_1/` | Versioned HOPE specification implementation | Check current CMS version; do not assume bundled version is current |
| `packages/hope/` | Shared HOPE domain code and tests | Reuse typed contracts and authoritative logic |
| `e2e/specs/hope.spec.ts`, `hope-attention.spec.ts` | Existing HOPE end-to-end test entry points | Expand verified real-user journeys, not just isolated screens |
| `docs/modules/CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md` | HOPE design/engine specification; expressly subordinates proposal to ratified ADRs, architecture, business logic and as-built code | Resolve conflicts against current authority hierarchy |

**Important limitation:** The code shows surfaces for submission and CMS result handling, but static inspection alone does **not** establish that unattended production iQIES transmission or acknowledgment retrieval is operational. Require an explicit integration proof.

## 2. Mandatory audit gate (no product code changes)

Create `docs/implementation/evidence/05-hope-current-state.md` with:

1. Git SHA, target branch, relevant deployment flags, and whether Workflow 04 changes have merged.
2. Complete navigation map from patient chart and org dashboard through timepoint capture, SFV, sign, submission, CMS result, correction, and historical viewing.
3. Role-by-role journeys: RN, authorized clinician, clinical supervisor, QA/compliance, submission operator, medical director where applicable. Record server permissions and actual route access.
4. Inventory of **actual** persisted states, transitions, UI labels, HTTP endpoints, generated client contracts, and data owners; distinguish timepoint state from submission state.
5. Current timepoint scheduling: Admission, HUV1, HUV2, Discharge and applicable SFV; document source events, clock anchors, calendar-day handling, time zones, missed/late workflows and exceptions.
6. CMS HOPE specification version(s) bundled, currently active, and accepted by the target submission system; verify against current CMS primary materials and approved compliance policy. Record effective dates and migration requirements.
7. Required/conditional items, skip logic, validation severities, source data prefill, reviewer overrides, amendment and signed-record protections.
8. Submission lifecycle and transport truth: draft package, validation, XML assembly, batch generation, transfer method, actual transmission evidence, CMS acknowledgments, rejected records, corrections and replay protection.
9. SFV trigger evaluation and scheduling, including event provenance, symptom reassessment, alerting and closure.
10. PHI protections: org isolation, patient/caseload access, consent restrictions, audit trail, encryption and sensitive exports.
11. Baseline tests and results, accessibility audit, keyboard navigation, mobile viewport behavior and synthetic-patient click-through screenshots **if an app is runnable**. Otherwise mark static-only.
12. Friction map with evidence: redundant pages, unnecessary clicks, ambiguous statuses, conflicting CTAs, missing next actions, confusing terminology and empty/error states.

**STOP GATE A:** Present audit, annotated as-is journey, API/data ownership map, and recommended to-be journey for approval. No product-code edits before approval.

## 3. UX design specification

### 3.1 Navigation and information architecture

Create a **patient-scoped HOPE Workspace** with five persistent areas:

- **Overview:** current timepoints, deadline/risk indicators, last completed record, next action, assigned owner, SFV alerts, submission outcome.
- **Complete assessment:** sections generated from the active versioned schema and applicability rules, with autosave or explicit draft save according to existing contracts.
- **Validation & sign:** authoritative blockers and warnings, exact field links, provenance, reviewer identity, explicit final attestation.
- **Submission:** package/batch membership, submission readiness, actual transport status, acknowledgment and CMS disposition, correction actions.
- **History:** chronological records, immutable signed snapshots, amendments, previous submissions and audit-linked changes.

The organizational HOPE dashboard and submission worklist remain separate cross-patient tools, but deep-link to the same patient workspace and task.

### 3.2 Page behavior

- Header: patient identity (minimum necessary), agency, HOPE timepoint, source event date, due date, owner and true current state.
- One **primary CTA** per state: e.g., `Continue draft`, `Resolve 3 errors`, `Review and sign`, `Open submission`, or `Review rejection`. Derive from server state/permission.
- Show deadline and *why* it exists; use the authoritative scheduling service, not client date math.
- Stepper/section navigation reflects applicability and actual completion, not a static checklist.
- Preserve entered answers when navigating sections; handle optimistic concurrency conflicts explicitly.
- Mark prefills as **suggested/derived** with source and timestamp; require review where clinical policy requires it.
- Distinguish **Not started / In progress / Needs review / Signed / Ready to package / Packaged / Transmitted / Accepted / Rejected / Corrected** only when corresponding actual backend states or trustworthy derived mappings exist. Do not invent new persisted states.
- Display SFV trigger and required follow-up as a linked clinical task, never as an unexplained error.
- Show recoverable errors with retry and retained user work; never imply success on timeout.
- Use Lantern shared tokens/components, responsive layout, accessible contrast, visible focus, keyboard and screen-reader semantics. No invented purple palette.

### 3.3 Patient vs organization experiences

**Clinician:** “What do I need to complete for this patient now?”
**Supervisor:** “Which timepoints are at risk, who owns them, and how do I intervene?”
**Submission operator:** “Which signed records are package-ready, what was transmitted, and what did CMS accept?”

Do not combine these into one giant dashboard. Provide links across them with preserved patient/timepoint context.

## 4. Non-negotiable clinical and regulatory controls

1. Preserve CMS HOPE record types/timepoints and **current authoritative** applicability/required-item logic. Verify actual regulations/specification against CMS primary sources before modifying any clinical rule.
2. HOPE and initial nursing/comprehensive assessments are related but distinct. Do not infer completion of one from completion of the other.
3. Never mark a draft as signed, or a signed assessment as submitted, or a transmitted record as CMS-accepted.
4. A late or missed timepoint must retain the true event date, late status and approved reason workflow; never silently backdate.
5. Preserve signature identity, timestamp, authorization, audit, amendment/supersession and historical reproducibility.
6. Preserve SFV trigger calculations and the **assessment visit-date anchor** documented in the module spec; verify implementation and current CMS rules before asserting any deadline.
7. Never change an accepted record in place or automatically resubmit a rejected record without validated correction workflow and audit.
8. Keep all PHI access server-authorized and tenant-scoped. UI hiding is not security.
9. Do not transmit to CMS from a UI shortcut or bypass the existing validation/submission pipeline.
10. Protect against duplicate batches, repeated user clicks, retried jobs and replayed CMS results.
11. No real patient data in fixtures, screenshots, AI prompts, external design services, or logs.
12. No regulatory compliance claim based only on a green UI badge or passing unit tests.

## 5. Engineering work packages

### WP0 — Audit, contracts, and approved design (PR 0; no behavior changes)

**Tasks**
- Complete Section 2 evidence package.
- Map old routes/components to proposed destinations; inventory redirects/deep links.
- Define patient/timepoint view model from **existing** read APIs; list genuine contract gaps separately.
- Produce desktop and mobile wireframes, annotated state diagrams, and a clinician click path for Admission, HUV1, HUV2, SFV and Discharge.
- Approve status taxonomy and compliance review of labels/deadlines.

**Acceptance:** Every proposed UI element has an authoritative source or an explicitly approved contract change; no undocumented state transitions.

**STOP GATE B:** Approval of design, contract gaps, and risk register.

### WP1 — Unified HOPE shell and navigation (PR 1)

**Tasks**
- Implement patient-scoped shell using `@chartwarden/ui` Lantern tokens and existing routing conventions.
- Add compact overview, timeline, current action, task owner, due date, and context links.
- Keep org dashboard and SFV/submission worklists; make them deep-link to patient tasks.
- Preserve old route behavior via redirects or compatibility wrappers where safe.
- Add accessible loading, empty, permission-denied, error, and offline/interrupted states.

**Acceptance:** Authorized users can reach any existing HOPE task from patient chart and return without losing context; no API behavior changed; permission-denied paths remain denied.

### WP2 — Guided assessment capture and review (PR 2)

**Tasks**
- Render active versioned HOPE sections and questions from existing typed definitions and applicability engine.
- Group sections by user task without changing CMS field identifiers or values.
- Provide progress, required/conditional item visibility, inline validation and source-linked prefill review.
- Reuse existing answer write, concurrency, draft and signature contracts; do not duplicate domain calculations.
- Support interruption, re-entry, concurrent edits, signed read-only state and authorized amendment flow.

**Acceptance:** Every field maps losslessly to the existing persisted schema; saved draft survives reload; validation and signature behavior matches backend; no answer is fabricated or silently overwritten.

### WP3 — Timepoint deadlines and SFV action center (PR 3)

**Tasks**
- Show server-derived windows, due dates, risk status, trigger provenance and assigned ownership.
- Integrate existing SFV worklist into patient overview with a clear `Open follow-up` action.
- Explain late/missed status and escalation path in plain language without weakening enforcement.
- Preserve admission/discharge event-driven scheduling and idempotency.

**Acceptance:** Date boundary, timezone, late completion, missing trigger, duplicate event and reassessment cases match server behavior and approved CMS rule fixtures.

### WP4 — Validation, signing and submission visibility (PR 4)

**Tasks**
- Present server validation errors grouped by section with exact links to fixable answers.
- Make sign/finalize a separate, explicit authorized action with review summary.
- Integrate patient-level submission status, package association and CMS result history.
- In org submission worklist, distinguish `ready`, `generated`, `transmitted`, `accepted`, `rejected`, and `unknown` **only when supported by real source states**.
- Surface correction/retry actions through existing controlled routes; prohibit unsafe client-side resubmission.
- Prove actual transport path; label manual upload/result recording honestly if automated iQIES connectivity is absent.

**Acceptance:** A signed record is not represented as accepted until an authoritative CMS disposition is recorded; rejected/partial/unknown outcomes remain distinguishable and auditable.

### WP5 — Cross-module handoffs and quality oversight (PR 5)

**Tasks**
- Integrate admission and discharge context without creating duplicate HOPE records.
- Link relevant encounter, symptom, IDG and quality information through existing read seams.
- Improve supervisor at-risk queue and exception drill-down without exposing unauthorized patients.
- Maintain reporting semantics and historical snapshots.

**Acceptance:** Links preserve patient/tenant context; cross-module failures degrade gracefully; metrics match authoritative queries.

### WP6 — Verification, documentation, rollout (PR 6)

**Tasks**
- Add DOM, API contract, integration, live-DB (where available), E2E and accessibility coverage.
- Run the repo's real lint/Biome, typecheck, build and relevant tests; record exact commands/results.
- Add release flag or controlled rollout when consistent with existing architecture; provide rollback to old UI without reverting clinical data.
- Update user guidance, screenshots, route maps, clinical training and ADR/spec references when architecture changes.
- Run synthetic-data clinician usability testing: time to find task, task completion, wrong-state interpretations, and navigation backtracks.

**Acceptance:** No unresolved critical clinical, authorization, data-loss, or submission-status defects; approved sign-off and rollback evidence.

## 6. Required test matrix (minimum)

| ID | Scenario | Required result |
|---|---|---|
| H01 | New admission creates HOPE obligation | Exactly one correct patient/timepoint obligation, no duplicate |
| H02 | Open Admission HOPE from patient chart | Correct record and next action |
| H03 | HUV1 and HUV2 timing boundaries | Server-defined deadlines, not browser clock guesses |
| H04 | Discharge after death/transfer/revocation as applicable | Correct branch and scheduling per approved rules |
| H05 | Conditional CMS item becomes applicable | Required item appears and validation updates |
| H06 | Conditional item becomes inapplicable | No stale blocking error or silent answer corruption |
| H07 | Prefill conflicts with current chart | Source, conflict and reviewer decision visible |
| H08 | Save incomplete draft, close, reopen | No data loss; not signed |
| H09 | Two clinicians edit same draft | Conflict detected; no silent overwrite |
| H10 | Unauthorized role attempts to sign | Server rejects; no signed state |
| H11 | Signed record reopened | Read-only except authorized amendment path |
| H12 | Missing required item | Exact field-level blocker; cannot sign if backend forbids |
| H13 | Symptom trigger creates SFV obligation | Correct trigger, owner, anchor and task |
| H14 | SFV near deadline / late | Accurate server-derived warning and escalation |
| H15 | Duplicate event or retry | No duplicate SFV/timepoint/submission side effects |
| H16 | Signed record included in submission batch | Correct package membership and version |
| H17 | Package generated but not transmitted | UI never says “submitted” or “accepted” |
| H18 | Transport failure / unknown acknowledgment | Honest unknown/failed state and safe retry guidance |
| H19 | CMS rejection | Reason visible, correction workflow available to authorized user |
| H20 | CMS acceptance | Only authoritative result produces accepted status |
| H21 | Duplicate CMS result import | Idempotent handling, no conflicting state |
| H22 | Wrong-tenant patient/assessment ID | Server denies and does not leak metadata |
| H23 | Caseload/consent/discipline restrictions | All protected server-side |
| H24 | Audit and historical reconstruction | Actor, time, before/after or amendment chain retained |
| H25 | Keyboard-only and screen-reader journey | Complete workflow operable and understandable |
| H26 | Mobile narrow viewport / 200% zoom | No clipped controls or inaccessible validation |
| H27 | Session expiration mid-edit | No false save; safe recovery guidance |
| H28 | Versioned CMS schema fixture | Correct validation and XML under active version |
| H29 | Org dashboard at-risk count vs source data | Counts and drill-down match authorized server data |
| H30 | Old bookmarked HOPE route | Compatible redirect or documented migration |

**Testing standard:** Unit tests alone are insufficient. At least one authenticated, synthetic-patient, end-to-end journey must demonstrate capture → validation → sign → package → recorded CMS outcome, with **manual vs automated transport truth explicitly identified**. If environment limitations block a step, report it as BLOCKED, not PASS.

## 7. Security, privacy, and reliability review

- Verify every new endpoint/view preserves `requirePermission`, ABAC, patient/caseload scope, org binding and RLS.
- Ensure no PHI appears in URL query parameters, browser analytics, console logs, error telemetry or screenshots.
- Use existing CSRF/session protections, concurrency keys, idempotency and outbox conventions.
- Audit all sign, amend, generate, transmit, result-record and correction operations.
- Avoid broad client caching of PHI; clear patient-scoped state when switching patients or organizations.
- Handle partial network failure, repeated clicks, stale tabs and job retries without false completion.
- Keep accessibility and plain-language terminology without obscuring official CMS labels in audit and exports.

## 8. Definition of done

- [ ] Approved current-state audit and UX design, including source-of-truth map.
- [ ] Existing HOPE routes and core contracts preserved or intentionally migrated with tests.
- [ ] One clear patient workspace and direct links from org worklists.
- [ ] Every visible deadline and readiness state traceable to server evidence.
- [ ] Draft, signed, packaged, transmitted, accepted, rejected and corrected semantics verified.
- [ ] SFV triggers, scheduling and missed/late cases unchanged unless explicitly approved.
- [ ] CMS active specification and regulatory rules verified and documented.
- [ ] No unauthorized cross-tenant/caseload access or PHI leakage.
- [ ] Synthetic end-to-end and regression tests pass, or blockers explicitly documented.
- [ ] Accessibility and responsive usability checked.
- [ ] Release/rollback, operational runbook, and clinician training complete.
- [ ] Clinical lead, compliance lead, QA and engineering approve release.

## 9. Claude Code execution contract

1. Read `AGENTS.md`, repository contribution rules, `docs/architecture/`, relevant ratified ADRs, `docs/BUSINESS_LOGIC.md`, the M10 module spec, and existing Workflow 04 implementation/evidence files **before planning edits**.
2. Re-run the repository discovery and establish current commit SHA. Do not trust paths or claims in this plan over current code.
3. **Start with WP0 only.** Produce evidence, proposed route map, screen designs and risk register. **STOP for approval.**
4. After approval, implement WP1–WP6 in small reviewable PRs. Never silently combine a regulatory-engine change with a visual refactor.
5. Preserve existing backend semantics by default. If an API/schema change is necessary, write a separate ADR/contract proposal with migration, backfill, tests and rollback; obtain approval first.
6. Do not invent missing CMS rules, iQIES capabilities, APIs, status transitions, or success results. Distinguish observed code, tested behavior, and unverified assumptions.
7. Use only fictional patients and non-production environments. Do not run destructive migrations or transmit test data to production CMS systems.
8. For each PR, report files changed, contracts affected, commands executed, results, clinical risks, screenshots, and outstanding blockers.
9. If Rust migration is active, identify code ownership and parity requirements; coordinate changes rather than duplicating HOPE business logic in Rust and TypeScript.
10. End each phase with a concise decision request; do not proceed past an explicit STOP gate without approval.

## 10. Suggested first Claude Code prompt

> Read `docs/implementation/05-hope-assessments-workflow-redesign.md` and execute **WP0 only**. Inspect the current ChartWarden repository and relevant architecture/ADR/CMS specification authority. Produce `docs/implementation/evidence/05-hope-current-state.md`, a route/API/state ownership map, a current-vs-proposed clinician journey, an accessibility and UX friction inventory, and a risk register. Do not modify application code, schema, or clinical rules. Stop and ask for approval before WP1.

---

**Next sequence:** Workflow 06 — Care Plan Management.
