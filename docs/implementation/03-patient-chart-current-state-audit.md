# Workflow 03 — Patient Chart & Demographics Current-State Audit

**Gate:** G0 — discovery and design approval only

**Checkout reviewed:** `fix/pr1036-main-conflicts` at `1066706b74b54c04656bfa8c00e6ceb14b8da852`

**Audit date:** 2026-11-14

**Approval status:** The four Workflow 03 boundaries in §14 were approved on 2026-11-14.

**Implementation status:** The approved implementation slices and their runtime follow-ups are implemented in the working tree. The demographics mutation now uses the typed PATCH contract and canonical re-read; demographics, address, and care-team mutation affordances require their exact session permissions; address transport failures restore the form; and dirty demographics are protected across Cancel/Escape, in-app navigation, and browser unload. The patient workspace now presents six primary groups with contextual subsection navigation while preserving every existing route and `?view=` deep link. Responsive Browser QA, layout-shift remediation, and the multi-role admission → activation → chart → edit → downstream journey are complete. A live last-write-wins characterization is committed to the existing private-Postgres suite; local execution remains blocked by the compliance hook even when both database URLs target a fresh dedicated container.

## 1. Scope and evidence quality

This audit follows the architecture-first rule and treats tenant RLS, request permission checks, composed ABAC/caseload scope, non-leaking 404s, read audit, append-only history, and step-up checks as invariants. The M5 screen registry exposes the census, global search, chart, and privacy-officer routes with their top-level permissions (`apps/web/src/modules/05-patient/screens.ts:21-70`). The backend then performs the decisive authorization.

Runtime evidence was initially blocked because the local stack rejected the gitignored credential fixture. After the synthetic account was repaired, Browser QA completed against `http://localhost:5173`: a controlled authenticated pass at 375, 768, and 1440 px verified the six primary groups, all ten Clinical subsection links, active states, scroll containment, and absence of document-level horizontal overflow. Axe reported zero automated WCAG A/AA violations, and the chart-only run produced no console errors, failed requests, or 4xx/5xx responses. LCP was 168–176 ms. An instrumented follow-up attributed the initial CLS (0.42 mobile, 0.17 tablet, 0.15 desktop) to staged patient-banner hydration, late allergy-panel insertion, and the patient-summary loading card expanding—not to the grouped navigation. Stable responsive footprints and loading shells reduced the same measurements to 0.00, 0.021, and 0.00; the residual tablet rail transition remains below the 0.1 target. Screenshots were visually inspected but not committed because no approved visual baseline exists. The repository's responsive Playwright spec exercised every assertion successfully across retries, but repeated local navigations intermittently entered the app's recoverable **You're offline** fallback, so it did not produce one uninterrupted 24/24 run. The complete multi-role Playwright journey then passed against the same stack: an organization administrator created, prepared, and activated a synthetic admission; the chart saved demographics through the canonical PATCH/re-read; the hospice physician observed the updated identity on the election/certification route; and the physician's missing `privacy.admin` permission suppressed the officer affordance and produced a direct 403 from the officer API.

Finding labels used throughout:

- **Verified defect** — demonstrated by a current code/contract mismatch or missing guard in the rendered UI.
- **Usability hypothesis** — plausible UX problem that requires runtime/user validation.
- **Policy/clinical decision** — behavior that needs product, clinical, privacy, or compliance authority.
- **Future enhancement** — desirable capability not required to repair an existing contract.

## 2. Entry-point and return-path map

| Entry point | Current path into chart | Return/deep-link behavior | Assessment |
|---|---|---|---|
| Patient census | `/patients`; row selection opens a quick summary and its **Open chart** action navigates to `/patients/:id` (`apps/web/src/modules/05-patient/patient-list-census.tsx:257-279`) | Chart URL is stable; the chart itself has no explicit census breadcrumb/back action in its local header | **Usability hypothesis:** browser Back works, but the originating census/filter context is not explicit |
| Global search | Patient results navigate to `/patients/:id`; staff results go to staff admin (`apps/web/src/modules/05-patient/global-search.tsx:333-358`) | Search term is kept in memory and scrubbed from legacy `?q=` URLs (`global-search.tsx:74-83`, `106-122`) | Existing privacy behavior is correct; preserve it |
| Referral | Referral detail navigates to a created/linked patient chart (`apps/web/src/modules/06-admission/referral-detail.tsx:447`) | Direct patient deep link | Verified entry point |
| Admission | Admission detail exposes **Open patient chart** and a direct care-team link (`apps/web/src/modules/06-admission/admission-detail.tsx:1758-1763`); admission census also links by patient id (`admission-census.tsx:392`) | Chart action menu links back to the admission when one is known (`apps/web/src/modules/05-patient/patient-overview.tsx:692-723`) | Verified bidirectional handoff |
| Discharge/death | Discharge worklist and death-pronouncement link to `/patients/:id` (`apps/web/src/modules/06-admission/discharge-worklist-ui.tsx:177-184`; `death-pronouncement.tsx:319-320`) | Direct patient deep link | Verified entry point |
| Care plan/orders/documents | Patient-scoped routes share the chart banner/tab strip; documents and orders include chart-return links (`apps/web/src/modules/22-documents/patient-documents.tsx:35`; `apps/web/src/modules/11-orders/patient-orders.tsx:397`) | Stable patient-scoped routes | Verified entry/return points |
| Messaging | Thread header and entity references link to the chart (`apps/web/src/modules/36-messaging/thread-header.tsx:157-158`; `rich-body-view.tsx:92`) | Chart actions can open the patient's care-team conversation (`patient-overview.tsx:675-676`) | Verified bidirectional handoff |
| Family portal | No staff-chart link was found in the portal surface. Portal behavior is a separate patient-self boundary. | Not applicable without an approved cross-app handoff | **Policy/clinical decision:** do not add staff-chart navigation to the portal by inference |
| Clinical worklists | Admission, discharge, intake review, orders, and documents have chart links; other worklists were not exhaustively runtime-walked | Deep links use opaque patient ids, not names/MRNs | Targeted chart navigation is runtime verified; the complete cross-worklist journey remains unwalked |

## 3. Current information architecture

The patient workspace has 13 horizontal destinations: Overview, Clinical, Election & Certification, Assessments, Plan of Care, Orders, Medications, Visits, IDG, Documents, Signatures, Claims, and Communication (`apps/web/src/shell/chart-module-rail.tsx:77-128`). The strip is an accessible `nav` with `aria-current`, and scrolls the active tab into view (`chart-module-rail.tsx:130-177`).

Overview contains a second navigation layer. Its Actions menu links to admission/HOPE plus Demographics & identifiers, Addresses, Coverage/payers, Care team/assignments, Privacy, Code status, Election/certification, and discipline plans (`apps/web/src/modules/05-patient/patient-overview.tsx:694-765`). The same M5 sections are also exposed as panel links, including **Edit** for Patient Information and **Manage** for Care Team (`patient-overview.tsx:881-965`, `1089-1112`). These resolve through `?view=demographics|addresses|coverage|care-team|privacy|code-status|clinical` (`patient-chart.tsx:98-117`) and render inline (`patient-chart.tsx:240-281`).

Current edit/action surfaces:

| Surface | Current interaction | Visibility behavior |
|---|---|---|
| Demographics | Modal opened by **Edit demographics** (`patient-chart.tsx:746-763`) | Rendered for every user who can open the `patient.read` chart; no `patient.edit` UI check |
| Addresses | Always-active **Add address** form (`patient-chart.tsx:1361-1465`) | Rendered for every chart reader; no `patient.edit` UI check |
| Coverage | Read-only in chart; intake has add/change coverage controls (`patient-intake-details.tsx:275-345`) | Chart does not expose payer mutation; intake is the second editor |
| Care team | **Assign care team member** modal (`patient-chart.tsx:2251-2275`, `2482-2580`) | Rendered for every chart reader; no `patient.assign` UI check |
| Privacy | Chart displays restriction/consent state; privacy-officer link appears only with `privacy.admin` (`patient-chart.tsx:2663-2669`, `2916-2922`) | Permission-aware link; backend remains decisive |
| Code status | Dedicated inline component and routes | Separate clinical permission, correctly not treated as generic demographics |
| Merge/amendment | Backend contracts exist, but the reviewed chart UI provides no unified administration/corrections destination | **Future enhancement** subject to clinical/compliance review |

**Finding IA-01 — Usability hypothesis:** 13 top-level tabs plus an Actions-menu-only set of patient-record subviews creates two competing navigation models. The strip is technically scrollable, but discoverability, mobile comprehension, and task grouping require runtime/user validation.

**Finding IA-02 — Verified defect:** edit/assignment affordances are not permission-aware. The screen registry requires only `patient.read` (`screens.ts:45-50`), while the visible actions invoke routes requiring `patient.edit` or `patient.assign`. Backend denial protects data, but read-only users are invited into actions they cannot complete.

## 4. Canonical data ownership

| Data | Canonical store/read | Canonical mutation | Current UI ownership and risk |
|---|---|---|---|
| Legal name, DOB, sex/SOGI, race/ethnicity, language | M5 `patient` spine (`packages/db/src/schema/patient/patients.ts:25-56`); `GET /patients/:id/demographics` (`patient-routes.ts:302-320`) | `PATCH /patients/:id`, `patient.edit` + caseload scope (`lifecycle-routes.ts:174-183`) | Demographics modal is intended owner, but calls a nonexistent contract; see DATA-01 |
| Preferred/other names | Append-style `patient_name_alias` (`patient-name-aliases.ts:9-32`), returned in demographics | M5 mutator can append preferred name (`seams/patient-mutator.ts:29-42`); no reviewed staff chart endpoint/form | **Policy/clinical decision:** define correction/append semantics before adding an editor |
| MRN and other identifiers | `patient_identifier`; MRN mirrored on `patient` (`patient-identifiers.ts:33-68`; `patients.ts:36`) | MRN immutable; other identifier creation is `POST /patients/:id/identifiers`; SSN/state id add extra permission and step-up (`lifecycle-routes.ts:218-285`) | Chart is read-only and masks sensitive identifiers; preserve |
| Addresses | Append-only `patient_address`, one current primary (`patient-addresses.ts:24-67`) | `POST /patients/:id/addresses`, `patient.edit` + scope (`patient-routes.ts:452-479`) | Duplicate editors in chart, intake, admission quick-add; all use the same endpoint, so ownership is canonical but UI behavior can drift |
| Patient phones/emails | M5 `patient_phone` and `patient_email` (`patient-phones.ts:11-35`; `patient-emails.ts:8-28`) | M5 mutator applies extracted/imported contact fields (`patient-mutator.ts:29-42`) | No reviewed direct staff chart read/write route. **Future enhancement**, not a field to invent in UI |
| Caregivers/legal representatives | M5 `patient_caregiver`, append/end-dated relationship with primary/LR constraints (`patient-caregivers.ts:23-60`) | `POST /patients/:id/caregivers`, `patient.edit` + scope (`lifecycle-routes.ts:287-315`) | Chart care-team response renders these read-only; no chart editor |
| Emergency contacts | M5 `emergency_contact` priority rows (`emergency-contacts.ts:9-32`), included in care-team view | No reviewed staff chart mutation route | **Policy/clinical decision:** define lifecycle/history before exposing edit |
| Coverage | M5 `patient_payer`; inclusive effective dates, active-rank uniqueness, DB exclusion constraint (`patient-payers.ts:25-55`) | Add successor: `POST /patients/:id/payers`; void: `/payers/:payerRowId/void` with payer permission + step-up (`patient-routes.ts:339-387`) | Intake edits; chart reads. Consolidate presentation, not domain ownership |
| Care team | M5 `patient_assignment`, one open primary RN (`patient-assignments.ts:14-45`) | assign/end routes require `patient.assign` + caseload scope (`assignment-routes.ts:83-133`) | Chart is the natural staff editor, but action visibility is wrong |
| Privacy flags | M5 denormalized snapshot sourced from M39 consent events (`patient-privacy-flag-snapshots.ts:12-36`) | Privacy-officer resync/rebuild uses `privacy.admin` (`privacy-routes.ts:42-116`) | General chart is read/fail-closed; officer surface is canonical administration |
| Code status | Append-only M5 `patient_code_status`; error correction marks a row entered-in-error (`patient-code-status.ts:14-49`) | Set/error routes require `patient.edit_code_status` + scope (`code-status-routes.ts:72-124`) | Dedicated clinical surface is canonical; do not fold into generic demographic edit |

**Finding DATA-01 — Verified defect:** the demographics form calls `PUT /api/v1/patients/{id}/demographics` through an untyped cast (`apps/web/src/modules/05-patient/patient-chart.tsx:690-728`). The backend exposes `PATCH /api/v1/patients/:id` (`lifecycle-routes.ts:174-183`), and no matching PUT route exists. Authorized demographics edits therefore cannot satisfy the implemented contract.

**Finding DATA-02 — Verified defect:** the unsafe cast around the nonexistent demographics PUT bypasses generated-client contract checking (`patient-chart.tsx:703-711`), allowing the route drift to compile.

**Finding DATA-03 — Usability hypothesis:** address and payer editing is duplicated across chart/intake/admission. The intake component independently manages loading, validation, and payer-name fan-out (`patient-intake-details.tsx:86-165`, `209-345`), while admission has a separate residence quick-add. Shared feature components/adapters could reduce drift without moving M5 ownership.

## 5. Permission and scope map

The permission catalog declares all patient read/edit variants and their ABAC expectations (`packages/auth/src/permissions/contributed.ts:522-660`). Declarations alone are not enforcement; route handlers compose guards.

| Action | Backend enforcement | UI state |
|---|---|---|
| Read census/search | `patient.read`; list is SQL-narrowed to org-wide scope, pinned patient, or open caseload; seam failure returns an empty census (`patient-routes.ts:187-225`, `237-285`) | Census/search registered behind `patient.read` |
| Read one chart/subresource | `patient.read` + `caseload_or_scope`, deny as 404 (`patient-routes.ts:149-166`, `289-413`) | Nonleaking combined not-found/outside-access message (`patient-chart.tsx:176-193`) |
| Edit demographics/address | `patient.edit` + scope (`lifecycle-routes.ts:174-183`; `patient-routes.ts:468-479`) | **Verified defect:** controls not hidden/disabled for read-only roles |
| Edit identifiers | `patient.edit_identifiers`; SSN/state id additionally require `phi.write_ssn` + step-up; reveal requires `phi.read_ssn` + step-up and `no-store` (`lifecycle-routes.ts:218-285`) | Chart renders masked values; no general reveal control reviewed |
| Edit coverage | `patient.edit_payers` + scope; void also step-up (`patient-routes.ts:355-387`) | Intake owns current editor; chart is read-only |
| Assign/end care team | `patient.assign` + scope (`assignment-routes.ts:42-45`, `83-133`) | **Verified defect:** assignment control shown to all chart readers |
| Code status | `patient.edit_code_status` + scope (`code-status-routes.ts:35-38`, `96-124`) | Dedicated component; role grant details remain authoritative in auth package |
| Merge | `patient.merge`, fresh step-up, and source + target scope for direct merge (`patient-routes.ts:168-185`, `481-507`); review-queue merge is org-scoped privileged workflow (`lifecycle-routes.ts:317-380`) | No reviewed chart entry point; preserve human confirmation/reversibility |
| Amendments | record request is scoped; review inbox/decision is compliance permission without caseload ABAC (`patient-routes.ts:509-540`; `lifecycle-routes.ts:384-433`) | No reviewed unified chart navigation |
| Privacy administration | `privacy.admin`, org RLS, read-audited (`privacy-routes.ts:42-116`) | Officer route registered separately and chart link permission-aware |

## 6. Integrity, concurrency, correction, and refresh

- The patient spine is immutable by id; MRN is unique per org and immutable after creation (`patients.ts:25-69`; `lifecycle-routes.ts:218-234`).
- Address replacement appends and closes history rather than overwriting (`patient-addresses.ts:1-4`, `46-48`). Payer windows have uniqueness and overlap protections (`patient-payers.ts:1-7`, `50-55`). Code status is append-only/error-corrected (`patient-code-status.ts:1-5`).
- Duplicate creation uses the admit match pipeline and can hard-block with a 409; bypass requires a dedicated permission, step-up, and justification (`patient-routes.ts:120-140`, `416-449`). Soft matches have a privileged review queue; merges are explicit and reversible within the implemented window (`lifecycle-routes.ts:317-380`).
- Amendments retain requests and decisions instead of silently overwriting; a denial can receive a statement of disagreement (`lifecycle-routes.ts:384-433`).
- The demographics database update loads the current row and performs an unconditional `UPDATE ... WHERE id`, with no version predicate (`patient-lifecycle-db.ts:119-143`).

**Finding INT-01 — Accepted and characterized:** demographics retains its approved initial last-write-wins policy. There is no optimistic version token or conflict response, and the UI does not claim otherwise. The existing M5 private-Postgres suite now performs two sequential demographics writes, asserts that the second value is canonical, and asserts that both `m5.patient.updated` events remain durable. The compliance hook blocked local execution of that live file even against a fresh dedicated container, so CI or an authorized live-suite runner must supply the final runtime result.

**Finding INT-02 — Resolved:** the typed PATCH now completes, the canonical demographics projection is re-read, and the chart banner/shared sources reconcile after a successful save. DOM and multi-role Playwright coverage exercise the path.

**Finding INT-03 — Resolved:** the address submit path restores saving state in `finally`, retains the draft, exposes a retryable error, and has focused transport-rejection coverage.

## 7. Privacy and disclosure posture

- Search terms stay in process memory, not URL/local/session storage; legacy query strings are scrubbed (`global-search.tsx:74-83`, `106-122`). Preserve this invariant.
- Chart and subresource reads compose permission + caseload scope and conceal denials as 404 (`patient-routes.ts:149-166`, `289-413`).
- SSN/state-id values are encrypted; normal reads serialize only masked/last-four data, while reveal is step-up protected and `no-store` (`patient-identifiers.ts:1-7`, `47-55`; `lifecycle-routes.ts:268-284`).
- Privacy flags are a fast, fail-closed snapshot (`patient-privacy-flag-snapshots.ts:1-5`). The chart hides protected detail when the privacy read is unknown and treats consent denial separately (`patient-chart.tsx:2676-2730`).
- The privacy officer read includes origin, Part 2 consent, detections, and history and is read-audited with a patient id (`privacy-routes.ts:52-76`).
- No patient-chart clipboard action or patient-specific analytics/console logging was found in the reviewed M5 UI. That is absence of evidence, not a telemetry platform audit.
- No general patient-chart break-glass route was found. Messaging has its own break-glass workflow; do not infer that it grants chart access.

**Finding PRIV-01 — Policy/clinical decision:** whether restricted-chart flags should suppress specific navigation/actions beyond existing backend enforcement requires privacy/security approval. The UI must not use a flag snapshot as an authorization substitute.

**Finding PRIV-02 — Future enhancement:** establish an explicit screenshot/recording redaction procedure before runtime baselines are committed. Synthetic data is necessary but diagnostic tooling can still capture local credentials, as this audit run demonstrated.

## 8. Cross-module flow and duplicate editors

```text
Referral / intake
      |
      v
M5 prospective patient ---- M6 admission activation ----> active chart
      |                           |                           |
      | addresses + payers       | admission/election        | M5 details
      | (shared M5 APIs)          |                           | M7/M8/M11/M12/M22 tabs
      v                           v                           v
canonical M5 rows -------- outbox/seams ------------ scheduling / billing / messaging
```

M6 intake reads and writes M5 addresses and payers through the same M5 endpoints (`patient-intake-details.tsx:86-165`, `209-345`), so it is not a second database owner. M5 assignments drive caseload scope (`patient-assignments.ts:1-4`) and messaging membership consumers. Coverage resolves payer display through M40 and feeds admission/HOPE and billing semantics. Chart tabs remain routes owned by their modules; the chart shell should group links without relocating mutation logic.

**Finding FLOW-01 — Usability hypothesis:** the same address/payer facts are edited at different workflow moments with different components and error behavior. Users may not understand which view is authoritative even though both hit M5 APIs.

**Finding FLOW-02 — Future enhancement:** shared M5 address/coverage feature components should be considered after the route contracts and permission-aware presentation are fixed. Extraction must preserve M6 workflow copy and not create a new cross-module data owner.

## 9. Accessibility and responsive audit

Static positives:

- Chart navigation is a named `nav`, uses real links and `aria-current`, and scrolls the active item into view (`chart-module-rail.tsx:130-177`).
- Census search/status controls have labels; the patient table has an accessible name/caption and keyboard row activation (`patient-list-census.tsx:204-254`, `337-343`; `e2e/fixtures/patients.ts:22-31`).
- Privacy retry preserves layout/focus and marks busy state (`patient-chart.tsx:2670-2674`, `2737-2742`).
- Assignment modal blocks dismissal while saving and exposes errors through `role="alert"` (`patient-chart.tsx:2482-2580`).

Runtime evidence:

- The grouped chart navigation and contextual strip remained reachable and contained at 375, 768, and 1440 px; the document itself did not overflow horizontally. The primary strip scrolls at 375 px, and the Clinical strip scrolls at all three sampled widths.
- Axe found zero automated A/AA violations on the medication workspace at all three widths. This does not establish full accessibility: dialog focus trap/restore, 200% zoom, screen-reader output, reduced motion, and the complete keyboard journey still require manual validation.
- The existing viewport matrix covers six widths and axe A/AA (`e2e/specs/viewport-matrix.spec.ts:1-39`); the chart-tab regression now checks both grouped navigation levels at four widths (`e2e/specs/patient-chart-tabs-responsive.spec.ts`). Every assertion passed across retries, with intermittent local offline-fallback noise preventing one uninterrupted matrix run.

**Finding A11Y-01 — Usability hypothesis:** the 13-item horizontal strip may remain technically operable yet obscure later destinations on narrow screens. Validate discoverability, focus visibility, and scroll position with the repaired runtime.

## 10. Performance and failure behavior

- Chart bootstrap first fetches the patient, then Overview launches at least ten independent reads for demographics, identifiers, addresses, care team, optional staff roster, care plan, election, encounters, visits, documents, medications, and privacy (`patient-overview.tsx:290-427`). Independent settlement prevents one failure from blanking the whole page.
- Opening a record subview keeps the Overview data hook active (`patient-chart.tsx:219-221`), then the subview performs its own reads. Demographics, addresses, care team, privacy, and coverage can therefore refetch data already requested for the overview.
- Coverage reads payer + HOPE in parallel, performs one M40 request per distinct payer, then may fetch a HOPE workspace (`patient-chart.tsx:1567-1662`). Intake repeats the per-payer lookup pattern (`patient-intake-details.tsx:135-162`).
- Census is server-filtered and cursor-paginated at 50 rows (`patient-list-census.tsx:146-165`, `257-270`); it does not download the whole org census.

**Finding PERF-01 — Verified defect:** chart subviews duplicate existing overview reads because `usePatientChartData` remains active regardless of selected section and subviews fetch the same resources again. This is a demonstrated request duplication, not yet a demonstrated user-visible latency regression.

**Finding PERF-02 — Usability hypothesis:** payer-name N+1 requests and the HOPE waterfall may be noticeable on slow networks. Measure request count/timing before batching or caching; preserve partial-error semantics.

**Finding PERF-03 — Resolved:** measured CLS initially exceeded the 0.1 good-experience target at 375, 768, and 1440 px (0.42, 0.17, and 0.15 respectively) while LCP remained below 200 ms. `LayoutShift` source attribution isolated three asynchronous expansions: patient identity/status hydration, allergy-panel insertion, and patient-summary loading-to-content growth. The chart now reserves responsive banner/status/summary footprints and renders a labelled allergy loading panel. The repeated measurements were 0.00, 0.021, and 0.00; the sole residual event was the tablet context rail transitioning out of the sampled viewport, below the target. No shift source implicated the six-group navigation.

## 11. Current test inventory and gaps

Existing coverage includes:

- Backend unit/route tests for patient routes, lifecycle, matching, assignment, privacy, code status, coverage intervals, outbox, census scoping, and write behavior under `apps/backend/__tests__/`.
- Live database tests for M5 RLS isolation, census caseload scope, assignments, code status, SSN encryption/reveal, payer interval integrity, matching, merge, and outbox behavior.
- Web DOM tests for search URL PHI, privacy, code status, care-team assignment/display/target size, chart data, clinical content, wristbands, and messaging integration under `apps/web/src/modules/05-patient/`.
- Playwright responsive navigation and six-width viewport/axe suites (`e2e/specs/patient-chart-tabs-responsive.spec.ts`; `e2e/specs/viewport-matrix.spec.ts`).

Workflow 03 test-matrix status:

- Focused DOM coverage now proves the generated-client PATCH contract and canonical demographics re-read.
- Focused DOM coverage now proves read-only users do not see demographics, address, or care-team mutation affordances.
- Focused DOM coverage now proves a rejected address transport restores the enabled form and exposes a retryable error.
- The complete Playwright journey now covers synthetic admission → activation → chart → demographics edit → second-role downstream read, including UI and API enforcement of a narrower permission.
- Targeted responsive/axe and instrumented layout-shift evidence are complete at three breakpoints.
- Dirty demographics now receive focused coverage for Cancel/Escape, in-app navigation, browser unload, retained input after **Keep editing**, and explicit discard.
- The approved initial last-write-wins policy now has a private-Postgres characterization in the existing M5 write/outbox suite. Its local run is **verification-blocked by the compliance hook**, not skipped or reported green; CI or an authorized live-suite runner must execute it.

## 12. Role journeys

| Role | Current journey | Risk/gap |
|---|---|---|
| Intake coordinator | Referral/intake → prospective patient → M5 address/payer editor → admission handoff | Duplicate presentation components; payer/address permission UX needs validation |
| Admitting RN | Admission detail → activate → chart/care-team/election links | Mutation affordances now require their exact permission; broader role-journey coverage remains useful |
| Case manager | Scoped census → chart overview → care plan/visits/medications/communication | 13-tab density; overview request fan-out; must preserve caseload-only visibility |
| Medical director | Scoped chart → code status/orders/certification | Clinical semantics must remain in dedicated modules/permissions |
| Biller | Coverage/claims destinations | Chart coverage is read-only while intake is editor; payer lifecycle/void must remain explicit |
| Privacy officer | Restricted-patient queue → officer patient view → resync/history | Separate `privacy.admin` route is correct; do not bury it in generic details |
| Administrator | Org-wide chart, assignment, matching/merge/amendment workflows | Privileged controls need explicit confirmation, step-up, and evidence; no chart hub today |
| Unauthorized/read-only staff | Direct deep link returns non-leaking not-found or read-only chart | Backend remains fail-closed; focused DOM coverage proves edit/assign controls are omitted without their exact permissions |

## 13. Proposed information architecture for approval

This proposal changes presentation grouping only. It does not move domain ownership, alter route permissions, weaken ABAC/RLS, or remove old deep links.

1. **Overview** — actionable summary and canonical links; no duplicate mutation logic.
2. **Patient details** — grouped read-first sections for Identity & identifiers, Contact information, Caregivers & emergency contacts, Addresses, Coverage, and Care team. Each action is shown only when the session holds its exact permission; backend remains decisive.
3. **Clinical** — group existing Assessment, Plan of Care, Orders, Medications, Code Status, Visits, and IDG destinations while preserving their current patient-scoped routes.
4. **Documents** — existing patient documents and signatures routes.
5. **Communication** — existing care-team conversation behavior.
6. **More / Administration** — Election/certification, privacy officer destination, amendments, merge/match review, claims, and other specialized actions, filtered by exact permissions and clinical/compliance policy.

Compatibility rules:

- Preserve every current patient-scoped route and `?view=` deep link initially; map them to the new group and add aliases/redirects only with route tests.
- Keep the persistent patient banner across every patient route; do not claim a visual banner is patient verification.
- Use read-first sections. Do not expose phones, emails, aliases, emergency-contact edits, merge, or amendment controls until their lifecycle and permissions are explicitly approved.
- Fix the demographics API contract and permission-aware controls before visual restructuring.
- Treat address/coverage component reuse as an incremental extraction over the same M5 APIs.

### Current and target task journeys

```text
CURRENT
Census/Search/Worklist -> Chart -> 13-tab strip
                              -> Overview panel links
                              -> Actions menu -> M5 detail views

TARGET
Census/Search/Worklist -> Chart + persistent identity context
                              -> Overview
                              -> Patient details -> exact-permission edit
                              -> Clinical / Documents / Communication
                              -> More/Admin -> privileged workflows
```

## 14. Approval boundary and recommended first implementation slice

G0 was reviewed and all four boundaries below were approved on 2026-11-14:

1. Adopt the six-group presentation IA in §13 while preserving all existing deep links.
2. Make every mutation affordance match its exact permission; do not infer edit rights from `patient.read`.
3. Keep M5 as canonical owner and share adapters/components with M6 rather than creating new chart-owned data contracts.
4. Treat demographics concurrency as an explicit policy decision: initially test/document current last-write-wins behavior unless a separate optimistic-locking contract is approved.

The approved implementation slices are complete: characterization tests and DATA-01/DATA-02 repair; permission-aware demographics/address/assignment affordances; the six-group presentation IA with compatibility-preserving subsection navigation; and demographics unsaved-change protection. Targeted responsive screenshots, automated accessibility evidence, layout-shift remediation, and the complete multi-role journey are complete. Current last-write-wins behavior is explicitly documented and covered by an added live characterization; its local execution remains blocked by the compliance hook. Any optimistic-locking contract remains a separate approval decision.
