# ChartWarden — Workflow 04: Initial Assessments Redesign

**Repository destination:** `docs/implementation/04-initial-assessments-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** Proposed — audit and approval required before code changes  
**Sequence:** After Workflow 03 (Patient Chart & Demographics); before Workflow 05 (HOPE Assessments)  
**Source baseline:** Static inspection of the user-uploaded `chartwarden-main.zip`, November 14, 2026. No running application, production database, or browser session was inspected.  
**Scope:** Initial hospice clinical assessment experience, including RN initial/comprehensive assessment handoff, interdisciplinary initial assessments, structured scale capture, documentation, signature, review, deadlines, and care-plan handoff. HOPE is an adjacent but **separate** workflow.

## 0. Executive decision

Build a **single patient-scoped Initial Assessment Workspace** that answers five questions immediately:

1. What assessment is required for this patient and discipline?
2. Who owns it and when is it due?
3. What information already exists from intake, admission, or previous charting?
4. What must the clinician complete, verify, sign, or escalate next?
5. What happens to the signed assessment (care plan, IDG, HOPE context, alerts)?

Do **not** replace the clinical assessment domain with one giant JSON form, create a second clinical record, or treat a completed scale as proof that the required initial/comprehensive assessment has been completed. Preserve existing lifecycle, signatures, authorization, source-of-truth calculations, and audit history.

### User experience target

**Patient chart → Assessments → Initial Assessment Workspace → Choose assigned assessment → Review existing data → Complete guided sections → Validate → Sign/finalize → Handoff to care plan.**

A clinician should never need to guess which screen to visit, which assessment is current, or whether clicking “Save” is equivalent to “Sign.”

## 1. Evidence from uploaded repository (recheck current branch)

The following are directly observed source anchors, not proof of a functioning end-to-end workflow.

| Source path | Observation | Implication |
|---|---|---|
| `apps/web/src/modules/09-assessments/assessment-timeline.tsx` | ~1,311 lines; patient-scoped scale timeline, selected scale history and trend UI; comments describe server-side redaction and scoring | Audit navigation complexity and separate scale capture from initial assessment completion |
| `apps/web/src/modules/09-assessments/record-assessment-modal.tsx` | ~230 lines; dynamic fields from `GET /api/v1/scales`; only `recordable` instruments offered; server computes scores | Reuse the dynamic instrument renderer and authoritative score calculation |
| `apps/web/src/modules/09-assessments/assessment-detail.tsx` | ~259 lines; read-only assessment detail loaded from patient-scoped endpoint | Preserve read-only signed/captured record views |
| `apps/web/src/modules/09-assessments/assessment-summary.tsx` | ~126 lines; latest score/interpretation per scale; server-side redaction | Use as supporting context, not as initial-assessment completion evidence |
| `apps/web/src/modules/09-assessments/significant-change-inbox.tsx` | Dedicated significant-change UI exists | Preserve decline detection, alerts and acknowledgment |
| `apps/web/src/modules/09-assessments/screens.ts` | Registers assessment timeline, detail, trend, summary, significant-change and scale administration screens | Review routing and information architecture without bypassing permission gates |
| `apps/web/src/modules/15-discipline-care-plans/assessment-editor.tsx` | ~385 lines; discipline assessment capture/sign/amend; **payload is entered as JSON** because per-kind schemas are not published to client; signed records are amended via new superseding rows | High-value UX problem: replace raw JSON entry only after establishing authoritative schema-driven form contracts |
| `packages/discipline-plans/src/cadence/initial-assessment.ts` | Typed discipline-specific clocks/anchors/satisfiers for MSW, spiritual, aide and volunteer workflows | Do not invent a universal initial-assessment clock; audit rule provenance and clinical applicability |
| `apps/backend/src/modules/09-assessments/routes/assessments-routes.ts` | Permission, ABAC, caseload scope, consent and concurrency safeguards documented in route source | Preserve server-side authorization and optimistic concurrency |
| `packages/assessments/src/scales/` | PPS, FAST, PAINAD and ESAS-r scale definitions/scoring implementations | Never recompute authoritative scores in UI |
| `e2e/specs/assessments.spec.ts` | E2E path tests scale recording and acknowledgment of a detected decline | Extend to initial-assessment workflows; current E2E does not prove all discipline assessments work |
| `docs/modules/CHARTWARDEN_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_3.md` | Defines module 09 assessment responsibilities and dependencies | Read alongside ADRs and code; spec explicitly says code and architecture/ratified ADRs take precedence |
| `docs/design/screens/clinical/CHARTWARDEN_UI_CLINICAL_ASSESSMENTS_SUITE.md` | Existing assessment screen design specification | Compare intended UX to actual implementation |
| `apps/web/src/modules/10-hope/` and `apps/backend/src/modules/10-hope/` | Dedicated HOPE module and UI exist | HOPE is Workflow 05; cross-link only, do not fold it into Workflow 04 |

**Important:** This static audit does not establish the current RN initial/comprehensive assessment UI, its signature lifecycle, or its exact timing logic. Claude must trace the actual RN/encounter/discipline pathways before designing or coding. The repository's per-discipline clock comments are not independent legal verification; confirm CMS rules and their applicability against current primary sources and approved compliance policy.

## 2. Audit gate — mandatory before implementation

Produce `docs/implementation/evidence/04-initial-assessments-current-state.md` containing:

- Current branch, commit SHA, repository date, deployment topology, and any differences from the uploaded snapshot.
- Complete route map: patient chart, assessment timeline, scale capture, encounter/visit documentation, discipline assessment editor, signature, amendments, care plan and HOPE links.
- Actual role journeys for RN, LPN, MSW, chaplain, aide supervisor, medical director, clinical supervisor, and quality reviewer. Mark unsupported journeys explicitly.
- Data ownership matrix for M6 admission, M8 encounters, M9 clinical scales, M10 HOPE, M15 discipline assessments, M7 care plans, M14 IDG and M22 documents.
- Actual persisted lifecycle states and transitions; server endpoints, request/response schemas, and generated client usage.
- Initial and comprehensive assessment due-time logic: event anchors, timezone, clock boundaries, warnings, blocking rules, escalation recipients and exceptions.
- Signature, co-signature, amendment, attestation, source provenance and locked-record behavior.
- Scope enforcement: organization, caseload, discipline, Part 2, proxy/DPOA, audit and redaction.
- Screenshots and click-through evidence from a **synthetic patient** in a local/staging environment, if runnable. If not runnable, label findings static-only.
- Current test coverage and failing baseline tests, with commands and outputs.
- Specific UX friction ranked by clinical risk, frequency and implementation cost; avoid treating file size alone as a defect.

**STOP GATE A:** Present this audit and an annotated navigation map for approval. Do not edit product code until approved.

## 3. Clinical boundaries and non-goals

- **Initial nursing assessment** and **comprehensive assessment** are not the same task; model each separately if existing domain contracts distinguish them.
- **Discipline assessments** (e.g., psychosocial and spiritual) may have their own lifecycle, ownership and documentation requirements; do not force them into one generic RN template.
- **Scales** (PPS, FAST, ESAS-r, PAINAD) are structured clinical observations, not a substitute for assessment narratives, signed interdisciplinary findings or physician certification.
- **HOPE** is a distinct CMS assessment and submission workflow; link its status without duplicating its data model or timepoint engine.
- **Care plan** is downstream; recommend or stage updates, but do not auto-publish clinically consequential goals/interventions without authorized review.
- Do not change CMS deadlines, state requirements, licensure scope, medical necessity rules, signature policy or authorization rules through frontend code.
- Do not add AI-generated findings, fabricated observations, implicit signatures or default “normal” clinical values.
- Do not assume every field can be prefilled safely; imported facts must display source, timestamp and verification status.

## 4. Proposed information architecture

### 4.1 Patient chart entry

Patient Chart → **Assessments**. Inside Assessments provide:

1. **Required now** — initial/comprehensive tasks and clinical blockers.
2. **In progress** — assigned drafts and resumable work.
3. **Completed** — signed/finalized assessments with immutable history.
4. **Scales & trends** — existing M9 timeline and dynamic capture.
5. **HOPE** — deep link to Workflow 05, with a distinct label.

Avoid an extra global navigation destination for each assessment subtype. Maintain existing URLs as redirects/aliases where possible, preserving bookmarks and deep links.

### 4.2 Initial Assessment Workspace

**Header:** patient identity, admission context, responsible discipline, assessment type, assigned clinician, due date/time, current state, last saved timestamp and privacy-sensitive indicators.

**Left rail (guided sections):** Overview → Patient history → Current condition → Symptoms and function → Safety and caregiver needs → Discipline-specific findings → Care plan implications → Review and sign. Derive exact sections from verified server contracts, not from this illustrative list.

**Main pane:** clear clinical questions, accessible controls, contextual prior data and source citations, concise validation errors near affected fields.

**Right contextual panel (collapsible):** source documents, recent visits, medications, allergies, current scales, orders, existing care plan, relevant HOPE status. Do not expose data beyond server permissions.

**Persistent actions:** Save draft; Review issues; Sign/finalize (only if authorized and eligible). Keep irreversible actions visually distinct.

**Status semantics:** Not started, In progress, Needs review, Ready to sign, Signed, Superseded, and Blocked are *proposed display labels*, not new database enums. Map only to verified persisted state and validation results. Do not create a parallel lifecycle.

### 4.3 Worklist and assignment

For each required task show: type, patient, assigned discipline/clinician, due timestamp, remaining time, actual server state, blocker count and a single **Continue** action. Offer filters for My tasks, Team tasks, Due soon, Overdue, Completed. Ensure assignment permissions and patient scope remain server-enforced.

### 4.4 Schema-driven forms

The discipline assessment editor currently accepts raw JSON because schemas are not client-published. **Do not replace it with hardcoded forms.** First choose an approved contract:

- Prefer a versioned, server-authored presentation schema mapped to the existing per-kind TypeBox validation; or
- Generate typed, validated field metadata from the authoritative schema with deterministic versioning.

Require field labels, descriptions, types, allowed values, required/conditional logic, units, provenance, accessibility, and validation error mapping. Reject arbitrary remote executable expressions. Preserve unknown fields during schema evolution and support older signed record versions. No schema change without compatibility tests.

## 5. Proposed step-by-step clinician journey

1. Open patient and confirm patient/admission identity.
2. See the required assessments and who is responsible.
3. Start or resume the correct assessment; prevent accidental duplicate drafts per existing policy.
4. Review carried-forward data, with explicit provenance and freshness indicators.
5. Enter findings section-by-section; save drafts without implying clinical completion.
6. Record structured scales via existing server-published instrument definitions when clinically relevant.
7. Review missing items, contradictions, safety concerns and required co-signature.
8. Sign/finalize using the existing authoritative lifecycle; display who signed and when.
9. Show resulting care-plan review tasks, significant-change alerts, IDG context and HOPE links without falsely marking those separate workflows complete.
10. For later corrections, follow append-only amendment/supersession rules and preserve original signed content.

## 6. Engineering work packages

### WP0 — Evidence, contract and design approval

**Tasks:** Complete Section 2 audit. Trace every assessment type, lifecycle and dependency. Identify whether initial RN assessment is authored in encounter/visit notes or a separate module. Create before/after user journeys and a low-fidelity desktop/tablet/mobile prototype using **Lantern** tokens and `@chartwarden/ui`. Obtain clinical/compliance sign-off on assessment categories and labels.

**Acceptance:** All proposed actions map to an existing verified API or a separately approved additive contract; no assumptions about compliance clocks.

### WP1 — Unified assessment entry and worklist

**Tasks:** Create reusable patient-scoped assessment shell; connect existing M9 timeline, M15 discipline editor and encounter assessments; show server-backed tasks and due state; add breadcrumb and patient context; preserve deep links, RBAC and caseload enforcement.

**Acceptance:** A clinician can identify and resume the correct initial assessment from the patient chart in no more than two intentional navigation actions after opening Assessments, where authorization permits.

### WP2 — Guided authoring and safe drafts

**Tasks:** Introduce structured form renderer only after schema contract approval; support save/resume, dirty-state protection, keyboard navigation, inline errors, offline/disconnect messaging without unsafe PHI caching, and conflict handling via existing version mechanisms. Keep raw JSON behind an authorized fallback until parity is proven.

**Acceptance:** No lost draft on normal navigation; stale concurrent edits do not overwrite newer data; unsupported schema versions fail safely.

### WP3 — Scales, provenance and contextual chart data

**Tasks:** Reuse `GET /api/v1/scales` and server score/interpretation; display clinically relevant prior values with timestamp and author; add safe navigation to medication/allergy/orders/visit context. Surface conflicting data for review rather than silently overwriting.

**Acceptance:** Scale scoring remains server-owned; source context is accurate and scoped; no “normal” value is auto-selected.

### WP4 — Validation, signature and amendment UX

**Tasks:** Provide a unified review screen for missing fields, clinical warnings and blockers; distinguish draft save from signing; preserve existing co-sign, attestation and amendment flows; make post-sign record read-only except authorized correction ceremony.

**Acceptance:** Server rejects invalid state transitions; UI cannot sign on behalf of an unauthorized actor; superseded records remain discoverable.

### WP5 — Handoffs and notifications

**Tasks:** After valid completion, display downstream status for care plan, IDG, alerts and HOPE without mutating them implicitly. Deep-link to existing module screens. Keep event/outbox consumers idempotent; do not introduce duplicate notification paths.

**Acceptance:** Assessment completion produces only approved downstream events; retry cannot duplicate clinical actions.

### WP6 — Quality, accessibility, rollout

**Tasks:** Add role-based browser E2E tests, unit/contract/integration tests, a11y checks, mobile responsiveness, telemetry without PHI, feature flag and rollback. Test with synthetic hospice cases and actual clinical reviewers.

**Acceptance:** Zero critical regressions in signatures, deadlines, patient scope, amendments or care-plan handoffs; explicit clinical sign-off before rollout.

## 7. Regulatory and clinical validation gate

Claude Code must consult current authoritative CMS sources and the organization's approved policies before changing deadline labels, required fields or blocking behavior. Verify, as applicable:

- 42 CFR §418.54 requirements for initial and comprehensive assessments, including timing, scope, updates and interdisciplinary participation.
- 42 CFR §418.56 for interdisciplinary care planning and review.
- Relevant discipline-specific hospice Conditions of Participation and applicable state rules.
- HOPE data collection and submission requirements under the current CMS manual; **do not** treat HOPE as equivalent to the initial/comprehensive clinical assessment.

Document a **rule matrix** with source URL, effective date, exact trigger, deadline, responsible discipline, exception, backend enforcement point and test ID. The repository's `packages/discipline-plans/src/cadence/initial-assessment.ts` contains implementation policy for several discipline plans; compare each rule to approved clinical/legal interpretation rather than assuming comments are regulatory authority.

**STOP GATE B:** Clinical/compliance lead must approve the rule matrix before changing any timing, requirement or activation gate.

## 8. Security and privacy invariants

- All reads/writes remain tenant-scoped and patient/caseload-scoped on the server; do not rely on hidden UI controls.
- Preserve ABAC/RBAC, consent and 42 CFR Part 2 redaction, proxy/DPOA checks and discipline restrictions.
- No PHI in browser analytics, telemetry events, console logs, URLs, error trackers or screenshots committed to source control.
- Protect drafts and uploads against cross-patient leakage; clear in-memory patient state when context changes.
- Preserve immutable signed records, append-only amendments, author attribution, audit actions and event ordering.
- Require explicit server authorization for co-signing, finalization, corrections and disclosure.
- Handle stale versions, duplicate submissions, interrupted requests and session expiration safely.

## 9. Test matrix — minimum acceptance scenarios

| ID | Scenario | Expected result |
|---|---|---|
| IA-01 | RN opens newly admitted synthetic patient | Required assessment shown with correct server-derived due state |
| IA-02 | MSW opens assigned assessment | Correct discipline task and scope; no unrelated clinical fields |
| IA-03 | Chaplain opens assessment with documented decline | Appropriate authorized declination path, if supported by backend |
| IA-04 | User opens patient with no active admission | Safe empty/blocking state; no invalid assessment write |
| IA-05 | User opens another tenant's patient URL | Server denies; no data disclosure |
| IA-06 | User lacks discipline permission | Write/sign controls unavailable and API rejects attempts |
| IA-07 | Draft saved, user leaves and returns | Same draft restored without falsely marking complete |
| IA-08 | Two clinicians edit same draft | Version conflict prevents silent overwrite |
| IA-09 | Form has missing required information | Specific inline errors; sign prevented by server |
| IA-10 | Existing record has inconsistent imported data | Conflict displayed with provenance; no automatic override |
| IA-11 | PPS captured in workspace | Server-generated score and interpretation match existing M9 behavior |
| IA-12 | Significant decline detected | Existing alert/acknowledgment flow remains intact |
| IA-13 | Assessment signed | Immutable view and audit attribution visible |
| IA-14 | Authorized amendment after signing | New superseding record; original retained |
| IA-15 | Unauthorized amendment attempt | Denied server-side and audited appropriately |
| IA-16 | Patient has Part 2-protected data | Server redaction and consent gates remain effective |
| IA-17 | Patient context switched mid-form | No draft data leaks to new patient |
| IA-18 | Network fails during save | Honest failure state; no false success or duplicate writes |
| IA-19 | Due-time boundary / DST change | Clock uses authoritative timezone and rule anchor |
| IA-20 | Assessment completed | Care plan/IDG/HOPE remain separately actionable, not auto-completed |
| IA-21 | Keyboard-only and screen-reader flow | All sections, errors and actions usable; WCAG 2.2 AA target |
| IA-22 | 320px mobile, tablet, desktop | No clipped clinical controls or inaccessible signature actions |
| IA-23 | Browser refresh on deep link | Correct patient and assessment load or safe authorization failure |
| IA-24 | Legacy signed record version | Readable without silent schema migration or data loss |

Add focused unit tests for schema renderer and status mapping; contract tests for authoritative definitions; live-DB tenant/ABAC tests; Playwright E2E for actual clinician journeys. **Never claim tests passed without command output.**

## 10. Proposed PR sequence

| PR | Deliverable | Merge gate |
|---|---|---|
| 04-01 | Audit, workflow map, rule matrix, approved UI specification | STOP GATE A + B |
| 04-02 | Unified assessment shell and patient worklist | Route/permission parity, accessibility smoke |
| 04-03 | Schema-driven discipline forms and safe drafts | Versioned schema contract + validation + concurrency tests |
| 04-04 | Review/sign/amend UX and contextual scale integration | Clinical sign-off + security tests |
| 04-05 | Handoffs, E2E suite, feature-flag rollout and documentation | All gates green; staged pilot approved |

Prefer small, reversible PRs. Avoid broad backend refactoring, schema migration or Rust migration work unless a specific gap is proved and separately approved. Do not modify the Rust migration repository as part of this plan.

## 11. Measurement and rollout

**Baseline before redesign:** task completion time, number of navigation transitions, draft abandonment, save errors, time-to-sign, overdue assessments, failed validation attempts and support tickets. Instrument only event type and safe aggregate metadata; exclude patient names, identifiers, free text and PHI.

**Pilot:** one agency, synthetic tests first, then authorized staged clinical pilot with trained RN/MSW/chaplain reviewers. Feature flag old/new experience; preserve legacy routes and data. Establish rollback criteria for failed signatures, deadline calculation mismatch, data loss, privacy breach, severe performance regression or increased clinical error.

**Targets (proposed, not observed):** clinician can find required assessment quickly; task completion time and navigation hops decrease; no increase in overdue work; zero severe privacy, data-integrity or signature defects.

## 12. Definition of done

- [ ] Evidence audit approved; all workflows mapped to real backend contracts.
- [ ] Current CMS/policy rule matrix approved by clinical/compliance owners.
- [ ] Lantern styling and shared UI components used; no invented palette.
- [ ] Initial RN, comprehensive, discipline and scale workflows correctly distinguished.
- [ ] No parallel lifecycle or duplicate patient/assessment records introduced.
- [ ] Draft, validation, signature, correction, consent and scope controls preserved.
- [ ] HOPE remains separately owned and reachable.
- [ ] Automated tests and browser scenarios executed with recorded results.
- [ ] Accessibility and mobile QA complete.
- [ ] Pilot sign-off, observability and rollback verified.
- [ ] Architecture, user guidance and change log updated.

## 13. Claude Code execution instructions

1. Read `AGENTS.md`, `CLAUDE.md` if present, architecture docs, ratified ADRs, `docs/BUSINESS_LOGIC.md`, and all sources listed in Section 1. Follow repository-specific instructions over this proposal when they govern execution.
2. Verify current branch and commit. Treat this document as **intent**, not proof of implementation.
3. Run a read-only source audit and produce Section 2 deliverables. Identify every unsupported assumption explicitly.
4. **STOP for human approval** before product code edits. Show evidence, scope, UX mockup and API impact.
5. Verify clinical timing and regulatory interpretation; obtain compliance sign-off before altering rules.
6. Implement approved PRs incrementally, keeping backend contracts and the Rust migration boundary intact.
7. Run targeted tests, typecheck, lint/Biome, accessibility, security and applicable live-DB gates. Report exactly what passed, failed or was blocked.
8. Never use production PHI or real patient data in development fixtures, prompts or screenshots.
9. For every PR, provide changed files, API/schema changes, clinical risks, tests, screenshots, rollback and known limitations.
10. If existing backend support is missing, propose the **smallest additive contract** and pause for approval; do not fabricate an endpoint or bypass server validation.

**Next workflow:** 05 — HOPE Assessments, to be handled in its own implementation plan.
