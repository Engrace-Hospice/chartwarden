# ChartWarden — Workflow 09: Clinical Visits & Documentation Redesign

**Repository destination:** `docs/implementation/09-clinical-visits-documentation-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** In progress (2026-11-20) — WP0 audit complete (2026-11-17, refreshed 2026-11-20 at `e7588e836`, [evidence §15](./evidence/09-clinical-visits-documentation-current-state.md)); **WP1 and WP3 approved 2026-11-20** and being delivered on `feat/wf09-wp1-wp3-visit-workspace` (not merged); **WP2, WP4, WP5, WP6 and the attestation-provenance fix (evidence §5) still require explicit approval** before product-code changes  
**Sequence:** After Workflow 08 (Visit Scheduling), before Workflow 10 (Electronic Visit Verification)  
**Baseline:** Static inspection of user-supplied `chartwarden-main.zip` (November 2026). No authenticated browser session, database execution, or live clinical verification performed.  
**Scope:** Staff-facing execution of scheduled/authorized hospice visits, clinical encounter authoring, documentation review, finalization, signature, cosignature, late entry, addenda, and handoffs to care plans, EVV, and reporting. Preserve existing backend domain authority and the Lantern design system.

---

## 0. Executive decision

Deliver **one Visit Workspace** that clinicians can enter from **My Visits**, **Scheduling**, or the **Patient Chart**, and complete without repeatedly jumping between unrelated screens. The user should always understand:

1. Which patient and visit am I documenting, and am I authorized to do so?
2. What information is required for this encounter type and discipline?
3. What have I completed, what is missing, and what has been saved?
4. Can I finalize or sign? If not, what exact blocker can I resolve?
5. Has the note been signed, routed for RN cosignature, or returned for follow-up?

**Target journey:** Assigned visit → open patient/visit context → begin/resume authorized encounter → document assessment, vitals, scales, narrative, and interventions → link relevant care-plan items → reconcile visit timing/EVV evidence → save draft → review assembled note → resolve server-reported blockers → finalize → step-up and sign → RN cosignature when applicable → immutable signed record and auditable addenda → downstream care plan, quality, billing and reporting consumers.

**Do not** collapse the scheduling visit and clinical encounter into a single fake status, invent client-side compliance clearance, permit signed-note edits, auto-sign AI text, silently rewrite EVV times, or remove existing audit/tenant/role controls. Do not add generic purple gradients; use ChartWarden's existing Lantern tokens.

## 1. Verified repository anchors — recheck on current branch

| File / directory | Static evidence and implication |
|---|---|
| `apps/web/src/modules/08-encounters/encounter-compose.tsx` | ~1,468-line HearthNote composer; draft sections, template requirements, selections, save and finalize actions. Candidate for focused component extraction. |
| `apps/web/src/modules/08-encounters/encounter-read.tsx` | ~3,505-line read/sign/cosign workspace; multiple signing ceremonies and addendum-related presentation. Major UX complexity candidate, not proof of a functional defect. |
| `apps/web/src/modules/08-encounters/patient-encounters.tsx` | ~830-line patient encounter list, status filters and navigation. |
| `apps/web/src/modules/08-encounters/my-drafts.tsx` | ~439-line clinician draft queue; explicitly links open drafts to composer. |
| `apps/web/src/modules/08-encounters/cosignature-queue.tsx`, `addendum-panel.tsx` | Existing cosignature and signed-note correction surfaces. |
| `apps/web/src/modules/08-encounters/encounters-api.ts`, `write-workflow.ts`, `encounter-status.ts` | Typed operations, sign/auth redirect handling and status vocabulary. |
| `apps/web/src/modules/17-scheduling/visit-detail.tsx` | Scheduling visit detail provides encounter navigation; preserve route and deep-link behavior. |
| `apps/backend/src/modules/08-encounters/lifecycle/encounter.ts` | Authoritative encounter lifecycle: `draft → finalized → signed` or `draft → finalized → cosign_pending → cosigned`; void permitted from draft, addenda separate. |
| `apps/backend/src/modules/08-encounters/gate/checks.ts`, `gate/gate.ts` | Compliance gate registry and evaluated/deferred checks; verify actual enforcement before promising a green checklist. |
| `apps/backend/src/modules/08-encounters/routes/encounters-routes.ts` | Server routes with permission/ABAC, author ownership, step-up, and version/concurrency semantics. |
| `apps/backend/src/modules/08-encounters/lifecycle/addendum.ts`, `late-entry/`, `cosignature/` | Append-only corrections, late-entry handling, cosigner routing and SLA behavior. |
| `apps/backend/src/modules/08-encounters/evv-at-sign.ts`, `apps/backend/src/modules/18-evv/` | Visit timing and EVV-related integration; distinguish encounter signing from EVV attestation. |
| `packages/hearthnote/`, `packages/db/src/schema/encounter/`, `packages/types/src/encounter.ts` | Note templates, versioned vocabulary and persistence contracts. |
| `docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md` | Existing design intent: section nav, narrative preview, context rail, sticky save/finalize/sign, blocker checklist, mobile/offline considerations. **Design intent is not evidence that offline or biometric signing works.** |
| `e2e/specs/encounters.spec.ts`, `apps/web/src/modules/08-encounters/__tests__/`, `apps/backend/__tests__/encounter-*.test.ts` | Existing automated coverage; inspect test quality and actual execution status. |

### Specific source findings that require investigation

1. **Two very large encounter screens.** `encounter-compose.tsx` and `encounter-read.tsx` divide authoring from signing/review. Audit whether users must bounce between them, lose context, or misunderstand the difference between *Save*, *Finalize*, and *Sign*. Do not remove the backend distinctions.
2. **Authoritative state machine exists.** `lifecycle/encounter.ts` models `draft`, `finalized`, `signed`, `cosign_pending`, `cosigned` and draft voiding. Do not invent `in_progress` or `completed` database statuses for convenience.
3. **Compliance gate has a registered-check model.** `gate/checks.ts` explicitly distinguishes evaluated checks from registered/deferred ones and contains comments about previously missing implementations. Audit every check's real behavior; a green UI must not imply an unimplemented rule was enforced.
4. **Attestation provenance needs special verification.** The source's `attestation_confirmed` check comments describe a distinction between stamped attestation text and an affirmative clinician acknowledgment. Confirm current route schema and service implementation; if a real gap remains, propose a separate, approved safety fix with tests rather than silently altering the sign contract.
5. **AI narrative enhancement may be incomplete.** The source comments describe Layer-2 modifications as unbuilt/deferred in that revision. Do not advertise automated clinical summarization, validated AI review, or source-grounded edits until implementation and human acceptance are demonstrated.
6. **Late-entry and cosignature requirements are not decoration.** The source has specific tiers, role-sensitive overrides, eligible-cosigner checks, step-up authentication and cosignature routing. Keep them server-owned and auditable.
7. **Offline documentation is described in the design spec, not established as production behavior.** Audit current persistence/sync, PHI storage, device policy and conflict handling before proposing offline-first UI.

## 2. WP0 — Mandatory current-state audit (STOP GATE)

**No application code changes during WP0.** Create `docs/implementation/evidence/09-clinical-visits-documentation-current-state.md` with:

- Git branch, commit SHA, working-tree status, relevant ADRs/specs, actual package scripts and architecture conventions.
- Entry-point and navigation map: scheduling visit → encounter create/resume → authoring → review → sign → cosign → addendum; include patient-chart and My Drafts paths.
- Screen-to-API-to-domain matrix, exact route names, request/response schemas, backend permissions, ABAC, role ownership, and tenant scoping.
- State-transition table for visit and encounter **separately**, including failure codes, retries, idempotency, version conflicts, draft voiding and downstream events.
- Encounter-type/discipline template inventory (RN, LPN, hospice aide, MSW, chaplain, physician, volunteer or other supported types). Do not assume every discipline uses identical templates or signature rules.
- Detailed inventory of HearthNote template sections, required vitals/scales, care-plan links, narrative assembly, vocab-version pinning, AI/Layer-2 flags and provenance.
- Evidence matrix for every compliance gate: enforced, evaluated but advisory, registered/deferred, or unverified; cite exact file:line and tests.
- Current signature, step-up, cosignature, late-entry, EVV reconciliation and addendum behavior; identify any security/clinical integrity gaps as separate findings.
- Hands-on fictional-patient walkthroughs (if runnable): start visit, save draft, interrupted edit, resume, missing required field, finalize, sign, LPN/aide cosign, correction, canceled/rescheduled visit.
- Desktop/tablet/mobile screenshots and usability observations: number of clicks, lost context, inconsistent buttons, terminology, errors, loading, keyboard/screen-reader accessibility.
- Existing test inventory and results, distinguishing passed, failed, skipped, blocked and not run; do not claim a test passed without execution.
- Data privacy review: local drafts, attachments, browser storage, signed documents, PHI in notifications, logs and exports.
- Scope matrix: **reuse / consolidate / modify / defer**, separating frontend-only changes from backend contract or schema changes.

**STOP:** Deliver audit, annotated screen map, proposed wireframes, risk register, implementation PR breakdown and unresolved questions. Wait for explicit approval before WP1.

## 3. Proposed experience — Unified Visit Workspace

### 3.1 Entry points and layout

**Header:** patient identity (with safety identifiers), visit date/time, clinician, discipline, visit type, encounter status and link to patient chart. Show patient context without duplicating a full chart. Keep an unmistakable **Back to My Visits** route.

**Primary working areas:**

1. **Document:** discipline-appropriate template with a compact section list (e.g., visit summary, symptoms/assessment, vitals/scales, interventions, care-plan links, narrative). The actual section names and requirements must come from existing template definitions.
2. **Review:** assembled note preview, missing/inconsistent content, sources, and clinician confirmation of accuracy. No fabricated narrative or auto-attestation.
3. **Complete:** server-derived compliance blockers, finalize, step-up/sign, cosign status and next actions.

**Context rail (collapsible):** relevant care-plan goals/interventions, current medication/allergy context if authorized and available, visit/EVV status, recent relevant encounters, and clinical warnings. Source every datum from the appropriate authorized backend; avoid stale or invented clinical values.

**Persistent action area:** `Save draft` when editable, `Review note` when ready, `Finalize` when permitted, `Sign` only after finalized and authorized. Explicitly explain that **finalize is not sign**. Never enable actions solely because frontend validation passes.

### 3.2 Drafting and progress

- Open existing draft before creating another; enforce actual server rules for one or multiple encounters per visit.
- Display save state: **Unsaved changes / Saving / Saved at [time] / Save failed**. Preserve unsaved input on navigation and failed requests; never claim persistence without server acknowledgment.
- Show template-derived required sections and an accurate completion count; optional content remains optional.
- Inline clinical validation and a focused **Needs attention** list with links to each field.
- On stale-version conflicts, show what changed and offer a safe refresh/reconcile path; never overwrite another clinician's edits silently.
- Support intentional clinical exceptions only when the backend accepts reasoned exceptions, such as a required vital marked clinically not indicated.
- Keep role-specific content concise. Do not make chaplain, MSW, RN, aide and physician users traverse irrelevant sections.

### 3.3 Review, finalize, sign

- Review shows a read-only rendered note plus source-linked selections/structured data, with explicit clinician responsibility for accuracy.
- Finalize invokes the existing server preview/validation transition; show actual blockers from server responses.
- Sign is a distinct ceremony requiring current role/ABAC, applicable step-up and affirmative attestation if supported/required by verified backend rules.
- Use exact statuses and next actions: **Draft → Finalized → Signed** or **Draft → Finalized → Cosign pending → Cosigned**.
- For LPN/CHHA notes requiring cosignature, show the RN destination and queue status; never describe the note as cosigned before the server records that event.
- Signed records are read-only; corrections use the existing addendum workflow and preserve original content and signature evidence.
- Late-entry tier, timestamps, override approvals and explanations must be visible without letting users self-authorize an override.

### 3.4 Scheduling, EVV and visit relationship

- Show visit schedule state separately from encounter note state. A visit marked completed must not be equated automatically with a signed encounter or an accepted EVV record.
- Link from visit detail and clinician agenda into the relevant encounter; maintain stable deep links and browser back behavior.
- If EVV evidence exists, display authoritative check-in/out times as read-only; allow reasoned reconciliation only through supported server workflows.
- For canceled, no-show or rescheduled visits, verify what encounter actions are legal; show explicit recovery guidance rather than silently discarding a draft.
- Do not change EVV, scheduling, billing or quality state machines in this workflow without separately approved cross-module work.

### 3.5 Mobile and accessibility

- Narrow screens: single-column sections, large touch targets, persistent save indicator, compact context drawer, no horizontal scrolling for forms.
- Desktop: section rail + documentation center + optional context rail; responsive behavior must use existing design tokens and components.
- Keyboard-only authoring, visible focus, clear error associations, screen-reader-friendly progress, no color-only status distinctions.
- Avoid transmitting PHI to client-side analytics, crash logs, browser notifications or third-party AI services.
- Offline mode is **out of scope unless WP0 verifies secure offline support**. If supported, require encryption, controlled storage, conflict resolution, logout wipe and explicit sync state; signing must remain online unless an approved design proves otherwise.

## 4. Implementation work packages (after approval)

### WP1 — Navigation and workspace shell

**Work:** Consolidate visit/encounter entry points; create shared patient/visit context header; introduce Document / Review / Complete navigation; preserve existing routes with safe redirects/deep links. Implement only against verified APIs.

**Acceptance:** User reaches a scheduled visit's correct encounter from My Visits, Visit Detail and Patient Chart; can return without losing context; permissions are unchanged; no duplicate encounter creation.

### WP2 — Discipline-aware authoring and draft safety

**Work:** Extract smaller components from `encounter-compose.tsx`; reuse existing HearthNote templates and typed client; add clear required-field progress, explicit save feedback, conflict handling and accessible controls. Preserve template versioning and clinically-not-indicated logic.

**Acceptance:** Supported discipline/template combinations render correctly; saves are server-confirmed; failed save cannot appear successful; no data loss on interrupted navigation; stale versions cannot overwrite silently.

### WP3 — Review and compliance blocker experience

**Work:** Reorganize assembled narrative preview and structured data review; build an actionable blocker panel using authoritative server responses. Clearly distinguish **not evaluated**, **deferred**, **failed**, **passed** where source supports that distinction. Do not hide backend deficiencies behind a cosmetic progress indicator.

**Acceptance:** Every actionable blocker links to its remedy; preview and final sign-time enforcement are distinguished; no false compliance-ready state; no unsigned content appears signed.

### WP4 — Signing, cosignature, late entry and addenda

**Work:** Simplify signing ceremony in `encounter-read.tsx`; preserve step-up, role/ABAC, explicit attestation, RN cosign queues, late-entry override and immutable addenda. Any confirmed backend safety defect requires a separate scoped proposal and explicit approval before modification.

**Acceptance:** Correct legal transitions; unauthorized sign/cosign blocked; no self-cosign bypass; expired step-up rejected; signed records immutable; corrections append-only; cosign and late-entry audit provenance retained.

### WP5 — Scheduling / EVV / care plan handoffs

**Work:** Improve navigation and read-only context across M17 scheduling, M18 EVV and M7 care plans; use existing cross-module seams and events. Do not introduce direct database coupling between modules.

**Acceptance:** Visit and encounter statuses remain distinct; EVV times remain authoritative; care-plan links are preserved; cancel/reschedule edge cases have correct server behavior and user explanations.

### WP6 — QA, accessibility, rollout and cleanup

**Work:** Add unit, component, API contract, integration, tenant-isolation and E2E tests; review performance, screen-reader behavior and mobile; add feature flag or staged rollout where existing infrastructure supports it; retire redundant UI only after parity evidence.

**Acceptance:** All required CI gates pass or blockers are documented; no PHI leaks; migration/rollback proven; no regression to old deep links, signed-note integrity, cosign or downstream consumers.

## 5. Mandatory test scenarios

| # | Scenario | Expected behavior |
|---|---|---|
| T01 | Clinician opens assigned visit from My Visits | Correct patient, visit and permitted encounter |
| T02 | User deep-links to visit encounter | Authorized access or safe denial; no cross-tenant data |
| T03 | Start encounter when existing draft exists | Resume/reuse per verified server rules, no accidental duplicate |
| T04 | RN creates and saves draft | Server-confirmed save and accurate status |
| T05 | Network fails during save | Clear failure, no false “Saved” message or silent loss |
| T06 | Two editors submit stale versions | Version conflict surfaced, no silent overwrite |
| T07 | Required template section missing | Actionable blocker and correct server refusal |
| T08 | Required vital clinically not indicated | Reason required and validated by authoritative rule |
| T09 | Wrong discipline/template pairing | Rejected by server, not merely hidden in UI |
| T10 | Draft finalized | Correct transition; not represented as signed |
| T11 | Sign attempted without valid step-up | Server rejects, UI explains reauthentication |
| T12 | Sign attempted with unacknowledged attestation | Verified server policy enforced; any gap reported |
| T13 | Sign attempted with unresolved compliance check | Correct server denial; no false-ready badge |
| T14 | RN signs authorized note | Signed state and immutable signature provenance |
| T15 | LPN or aide signs note requiring RN cosign | `cosign_pending` and appropriate RN routing |
| T16 | Ineligible RN tries cosign | Server rejects, audit retained |
| T17 | Cosign completed | `cosigned` only after authoritative transition |
| T18 | Late-entry threshold crossed | Correct tier, reason and permitted override path |
| T19 | Unauthorized late-entry override | Denied without state mutation |
| T20 | Edit signed note | Prohibited; direct to append-only addendum |
| T21 | Addendum signed | Original record unchanged; correction traceable |
| T22 | Encounter linked to rescheduled visit | Accurate relationship and valid action gating |
| T23 | Visit canceled/no-show while draft exists | Correct recovery and no fabricated visit completion |
| T24 | EVV check-in/out present | Authoritative times read-only and accurately displayed |
| T25 | EVV absent or inconsistent | Existing supported exception/reconciliation path used |
| T26 | Care-plan link selected | Correct authorized link, no duplicate plan mutation |
| T27 | Patient switched during authoring | No stale patient data or cross-patient write |
| T28 | Cross-tenant encounter ID probed | Denied without PHI disclosure |
| T29 | Clinician without assignment/role attempts sign | Server denies regardless of UI |
| T30 | Desktop, tablet, mobile, keyboard, screen reader | Usable and WCAG 2.2 AA-targeted behavior |
| T31 | Refresh after successful save | Draft and correct status reload from server |
| T32 | Signed note used by downstream consumer | No regression to event delivery or reporting |
| T33 | Deferred/unimplemented gate surfaced | Not misrepresented as enforced/passed |
| T34 | Layer-2 AI unavailable | Safe manual workflow; no invented AI result |
| T35 | User session expires mid-ceremony | No false signature; safe reauth and recovery |
| T36 | Original deep links and back navigation | Preserve routes and patient/visit context |

**Execution rule:** Test cases are requirements, not claims of existing passing coverage. Record evidence and distinguish mocked, component, integration and live-database verification.

## 6. Suggested pull requests and gates

| PR | Scope | Required gate |
|---|---|---|
| PR0 | WP0 audit and design approval | **STOP** for user approval; no application code |
| PR1 | Unified workspace navigation and context | Route parity, authorization and visual review |
| PR2 | Discipline-aware authoring and draft safety | Save/conflict/template regression tests |
| PR3 | Review, blockers and signing experience | Server gate, attestation, step-up, cosign, addendum tests |
| PR4 | Scheduling/EVV/care-plan handoffs | Cross-module contracts and end-to-end journeys |
| PR5 | Accessibility, mobile, rollout, cleanup | E2E, security, performance, rollback and acceptance |

No PR may bypass the prior approval gate. Keep PRs small enough for clinical review. Avoid schema migrations unless independently justified and approved.

## 7. Clinical, security and regulatory guardrails

- Preserve HIPAA minimum-necessary access, tenant isolation, role/assignment checks, immutable audit evidence and signed-document integrity.
- Do not claim CMS or Conditions of Participation compliance based on UI appearance; verify the exact rule and source of truth before modifying deadlines or required content.
- Never make clinical judgments or medication recommendations from AI-generated text without authorized clinician review; keep source/provenance where supported.
- Do not transmit PHI to third-party telemetry, demo services or unapproved LLM providers. Use synthetic data for all demos/tests.
- Preserve signatures, cosignature identity, late-entry audit trail, author attribution, timestamps and event idempotency.
- Handle errors as recoverable workflow states; never display “signed,” “saved,” “synced,” or “completed” before backend confirmation.
- Treat feature parity as mandatory for existing users; document any deliberate removals with user approval.

## 8. Definition of done

- A clinician can open a visit, document, save, review, finalize and sign (or route for cosign) in one comprehensible journey.
- Existing encounter lifecycle, server gates, roles, step-up, late-entry, addenda and audit rules remain authoritative.
- Required sections and blockers are accurate for each supported encounter type and discipline.
- Patient/visit/encounter identities cannot be confused or crossed; tenant isolation and assignment checks are proven.
- Scheduling, EVV, care-plan and downstream event integrations have regression coverage.
- Responsive and accessible UX meets approved design and Lantern token requirements.
- Tests and manual evidence are attached; unsupported claims and deferred gates are disclosed.
- Rollback, monitoring, feature flags (if available) and clinical sign-off are documented.

## 9. Claude Code execution instructions

1. Open this plan and read the current repository's `AGENTS.md`, `CLAUDE.md`, architecture docs, ADRs, design-token guidance and all referenced files. **The uploaded archive is only the planning baseline; current branch is authoritative.**
2. Confirm Workflow 08 scheduling changes and any relevant Workflow 04/06/07 dependencies; do not assume previous plans were merged.
3. Execute **WP0 only**. Produce the evidence document with exact source line references, actual route contracts, screens, gate status, test commands/results, and annotated proposed UI architecture.
4. Report verified defects separately from UX preferences and unimplemented design-spec aspirations. Highlight `gate/checks.ts` evaluated/deferred checks and attestation acknowledgment explicitly.
5. **STOP and request approval**. Do not edit application code, schemas, auth policies, clinical rules, or signatures before approval.
6. After approval, implement WP1–WP6 as scoped PRs. Use existing typed API clients, domain seams, test fixtures, design tokens and repository conventions.
7. For every PR: document changed files, UX before/after, API/DB impact, security considerations, test commands and outcomes, remaining risks, rollback and clinical reviewer sign-off.
8. Do not claim production readiness until relevant E2E, integration, security and clinical validation gates actually pass.

**Next workflow:** Workflow 10 — Electronic Visit Verification (EVV).
