# ChartWarden — Workflow 03: Patient Chart & Demographics Redesign

**Repository destination:** `docs/implementation/03-patient-chart-demographics-workflow-redesign.md`  
**Executor:** Codex  
**Status:** In progress; G0 and the four §14 boundaries approved, approved UI slices and runtime follow-ups complete  
**Sequence:** Workflow 03, after Unified Intake and Patient Admission  
**Source baseline:** Static inspection of user-provided `chartwarden-main.zip` (November 14, 2026). Current-checkout runtime evidence and remaining gaps are recorded in `03-patient-chart-current-state-audit.md`.  
**Primary objective:** Make finding, identifying, reviewing, and correcting a patient's chart intuitive while preserving existing clinical, privacy, authorization, and data-integrity behavior.

## 0. Executive direction

Redesign the **patient census → patient chart → demographics/contacts/coverage → clinical context** experience as one coherent workspace. The user must always know (1) which patient they are viewing, (2) whether they have the right patient, (3) what they can do next, (4) which information is verified versus incomplete, and (5) where to edit or request correction.

This is **not** a patient database rewrite or an excuse to flatten every clinical module into one enormous page. Preserve existing routes, typed contracts, backend authorization, audit events, patient identity controls, and domain ownership. Use ChartWarden's **Lantern** design system and actual repository tokens, not generic purple gradients or an invented palette.

### Non-goals

- Replacing patient identity, admission, payer, privacy, or clinical domain services.
- Rewriting the Rust migration or assuming Rust endpoints are already in production.
- Introducing client-side PHI caching, patient identifiers in analytics, or unsafe search URL parameters.
- Auto-merging patients, silently overwriting verified demographics, or changing the meaning of a signed record.
- Replacing role-based or attribute-based access controls with frontend-only checks.
- Creating a competing intake form or admission workflow.

## 1. Verified source anchors (revalidate on current branch)

These paths and the stated behaviors were observed in the uploaded ZIP. File sizes indicate potential complexity, **not independently proven UX defects**.

| Path | Verified source observation | Review implication |
|---|---|---|
| `apps/web/src/modules/05-patient/patient-list-census.tsx` | ~525 lines; patient list uses `GET /api/v1/patients`, census metrics use `/api/v1/patients/census-metrics` | Map filtering, row actions, paging, access-scope messaging, empty/error states |
| `apps/web/src/modules/05-patient/global-search.tsx` | ~587 lines; patient search uses `/api/v1/patients` and staff search uses organization members endpoint; source comments discuss not retaining PHI search terms in persistent browser storage | Verify privacy-preserving search, keyboard access, deduplication with census |
| `apps/web/src/modules/05-patient/patient-chart.tsx` | ~3,958 lines; reads patient, demographics, identifiers, addresses, payers, care team, HOPE, privacy and consent-related data; writes demographics and addresses | Identify excessive tab nesting, independent loading/error states, unsafe edit affordances, and component boundaries |
| `apps/web/src/modules/05-patient/patient-overview.tsx` | ~1,816 lines; aggregates demographics, identifiers, addresses, care team, care plan, election/certification, encounters, visits, documents, medications and privacy flags | Avoid duplicated network fetching and competing summaries; preserve cross-module ownership |
| `apps/web/src/modules/06-admission/patient-intake-details.tsx` | ~1,014 lines; separately reads/updates addresses and payer information during intake | Reuse shared patient data components without introducing a second canonical editor |
| `apps/web/src/modules/05-patient/patient-clinical.tsx` | Patient clinical UI exists | Clarify clinical context vs. demographic editing responsibilities |
| `apps/web/src/modules/05-patient/patient-privacy.tsx` and `privacy-queue.tsx` | Privacy UI and officer queue exist | Preserve sensitive-data restrictions and appropriate escalation paths |
| `apps/web/src/modules/05-patient/patient-code-status.tsx` | Code-status UI exists | Keep clinical semantics and authorization separate from demographic convenience edits |
| `apps/backend/src/modules/05-patient/routes/patient-routes.ts` | ~541 lines; routes for census, patient, demographics, identifiers, payers, care team, privacy flags, addresses, merge and amendments; comments describe caseload-scoped ABAC | Never broaden data visibility; validate backend authorization and concealment behavior |
| `apps/backend/src/modules/05-patient/routes/privacy-routes.ts` | Privacy restrictions and administrative resync/queue endpoints | Preserve privacy workflows and separate administrative permissions |
| `apps/web/src/modules/05-patient/search-url-phi.dom.test.tsx` | Test exists for search/URL PHI handling | Extend rather than delete privacy regression coverage |
| `apps/web/src/modules/05-patient/patient-privacy.dom.test.tsx` | Privacy DOM tests exist | Include restricted-chart scenarios |
| `apps/web/src/modules/05-patient/chart-data-members.dom.test.tsx` | Chart member data tests exist | Preserve membership/care-team data behavior |
| `e2e/specs/patient-chart-tabs-responsive.spec.ts` | Responsive chart navigation test exists | Extend desktop/tablet/mobile coverage |
| `docs/design/screens/clinical/CHARTWARDEN_UI_PATIENT_CHART.md` | Existing patient chart design documentation | Compare proposed UX with existing product intent and Lantern rules |

**Important:** The patient-route source includes an explicit explanation that declared ABAC is not sufficient unless enforced by request guards and SQL-level list narrowing. Treat caseload filtering, tenant isolation, and unauthorized 404 behavior as **security invariants**, not presentation preferences.

## 2. Mandatory Gate G0 — Evidence-based current-state audit

Before implementation, create `docs/implementation/03-patient-chart-current-state-audit.md` and include **file:line references from the current checkout**. Do not rely on the ZIP's line numbers or assume earlier plans have landed.

1. **Entry-point map:** census, global search, referral, admission handoff, visit, messaging, family portal, clinical worklists; chart back-navigation and deep links.
2. **Information architecture:** every patient chart tab, subtab, modal, action menu, edit form, and duplicate information surface. Capture which roles see which actions.
3. **Canonical data ownership:** identify source-of-truth API, database model and update endpoint for legal name, preferred name, DOB, identifiers/MRN, addresses, phones, caregiver/emergency contacts, payer coverage, care team, privacy flags and code status. Do not assume all fields are editable.
4. **Permission map:** `patient.read`, `patient.edit`, payer-specific permissions, SSN permission, merge, amendments, privacy, care-team permissions and ABAC/caseload constraints. Verify actual handlers and tests.
5. **Data integrity:** patient matching and merge workflow, concurrency/optimistic locking if present, amendment history, duplicate prevention, stale data and cross-tab refresh.
6. **Privacy:** restricted charts, special privacy flags, sensitive identifiers, consent visibility, break-glass if supported, URL/search/browser history, clipboard, logs, error telemetry, and document links.
7. **Cross-module data flow:** intake → admission → chart → care team → scheduling → billing. Identify duplicate editors and whether edits propagate or conflict.
8. **Accessibility:** keyboard navigation, focus order, dialogs, form labels, touch targets, contrast, zoom, mobile tab overflow, screen-reader announcements.
9. **Performance:** initial chart request fan-out, loading waterfalls, refetch frequency, cache invalidation, large census pagination and slow-network states. Measure before optimizing.
10. **Testing:** list current unit, DOM, integration, E2E, API, security and live-DB tests; identify blocked prerequisites separately.
11. **User journeys:** intake coordinator, admitting RN, case manager, medical director, biller, privacy officer, administrator, unauthorized staff member.
12. **Baseline UX evidence:** screenshots or video of current chart/census in a safe synthetic dataset. If unavailable, explicitly mark `NOT RUNTIME VERIFIED`.

For every finding label it **Verified defect**, **Usability hypothesis**, **Policy/clinical decision**, or **Future enhancement**. Produce a route/action inventory with ownership and risks.

**G0 approval gate:** Do not change code until the audit is reviewed and the proposed IA is approved. Where backend behavior is uncertain, write a test or document the uncertainty rather than guessing.

## 3. Target user experience

### 3.1 Patient census: fast and safe patient discovery

- Keep a clearly labeled **Patients** worklist, with server-backed search, useful filters and existing scope restrictions.
- Display a compact patient identity row using only fields the actor may view: name, optional preferred name, masked/appropriate identifier, status, relevant location/team, and next-care context where available.
- Make the entire row or explicit **Open chart** action accessible; avoid multiple ambiguous click targets.
- Provide clear empty, loading, error, restricted-scope and no-search-match states; distinguish **no matching patients** from **no permission to view** without leaking existence.
- Preserve cursor pagination and server-side filtering; never download the entire census to filter client-side.
- Do not persist PHI search queries to localStorage, sessionStorage, URL, analytics, or telemetry.
- If census and global search overlap, share search semantics and patient result presentation without removing distinct legitimate workflows.

### 3.2 Persistent patient context header

Across chart sections display a compact, accessible identity header with:

- Name and authorized identifiers, with an unambiguous patient context indicator.
- Age/DOB where authorized and clinically relevant; avoid confusing age with date of birth.
- Current care/admission status, organization/site, and assigned care team where available.
- High-importance safety context (e.g. allergies, code status, restrictions) **only from authoritative sources**, with correct freshness and permission behavior.
- An explicit **Verify patient** affordance or patient-identification protocol when initiating high-risk actions; do not treat a visual banner as clinical identity verification.
- Back-to-list and recent context links that do not leak patient data into URLs or browser storage.

The header must not imply a safety field is negative when the field is **unknown**, **not assessed**, **unavailable**, or **restricted**.

### 3.3 Recommended top-level chart navigation

Use a small set of user-centered destinations, not every backend module as a tab:

1. **Overview** — current care context, key alerts, next visit, active care plan and actionable tasks; links to canonical screens.
2. **Patient details** — demographics, identifiers, contact information, caregivers, addresses, coverage, primary physician, and documented preferences; sections should clearly identify editable vs. read-only fields.
3. **Clinical** — assessments, care plan, medications, allergies, code status, clinical history; navigate to existing canonical clinical modules.
4. **Care activity** — visits, notes, orders, care-team activity and communications as authorized.
5. **Documents** — patient-linked documents, signatures, source evidence and history through existing document services.
6. **More / Administration** — privacy, amendments, merge, specialized workflows, and audit/history according to permission.

**These are presentation groupings, not a mandate to relocate domain code.** G0 must decide whether fewer/more groups are justified. Preserve deep-link compatibility and provide redirects or route aliases where necessary.

### 3.4 Patient details: one clear edit model

- Use read-first sections with explicit **Edit** actions; do not present every field as an always-active form.
- Group logically: **Identity**, **Contact information**, **Caregivers & emergency contacts**, **Addresses**, **Insurance & coverage**, **Care team**, **Privacy & preferences**.
- Distinguish legal name, preferred name, contact, authorized representative, primary caregiver, emergency contact and referral contact; do not conflate them.
- Prefill verified data from intake/admission; show provenance or last-reviewed status only where supported by current data model.
- Edit via existing authorized typed endpoints; validate server-side and show inline field errors.
- Handle unsaved edits, stale data, concurrent edits, duplicate submissions, network retries, and save confirmation accurately.
- For immutable/sensitive identifiers and signed data, route to authorized amendment/correction workflows rather than silent mutation.
- For coverage, show payer and coverage period in plain language; preserve existing payer row lifecycle and void semantics.
- Do not allow editing restricted data simply because the UI can render a text field.

### 3.5 Overview: useful clinical summary, not a second chart

- Prioritize the next clinical task, next visit, care team and relevant alerts.
- Use concise cards with a **View details** link to authoritative module screens.
- Label unavailable/unknown/not applicable distinctly; never fabricate a green completion status.
- Avoid displaying PHI-heavy content unnecessarily on shared workstations or small screens.
- Use accessible density controls only if existing design conventions support them; prioritize clear defaults.
- Do not duplicate order entry, medication administration, signature, or clinical note editing inside the overview.

### 3.6 Privacy and corrections

- Restricted patient charts must remain protected by backend permission, ABAC and RLS; no optimistic display of protected data before authorization resolves.
- Privacy flags and consent restrictions must influence navigation and visible actions where appropriate, without substituting for backend enforcement.
- Patient merge requires privileged, explicit confirmation, matching evidence, and existing audited backend behavior. No automatic merges.
- Record amendments must preserve prior versions and review decisions according to current domain rules; do not implement overwrite-as-correction.
- Show understandable error messages without revealing restricted chart existence or PHI.

### 3.7 Mobile and responsive

- Desktop: persistent patient header and restrained tab navigation.
- Tablet: responsive sections and accessible overflow handling.
- Mobile: compact identity context, clearly labeled navigation, readable forms and large touch targets; no horizontal scrolling for essential fields.
- Never hide a critical safety alert solely because of viewport size.
- Respect reduced motion, 200% zoom, keyboard focus and assistive technology.

## 4. UI component architecture

Prefer small feature components and adapters while keeping the existing router and domain APIs:

```text
PatientWorkspace
├── PatientContextHeader
├── PatientWorkspaceNavigation
├── PatientOverviewPanel
├── PatientDetails
│   ├── IdentitySection
│   ├── ContactsAndCaregiversSection
│   ├── AddressesSection
│   ├── CoverageSection
│   └── CareTeamSection
├── ClinicalLinksPanel
├── ActivityLinksPanel
├── DocumentsLinksPanel
└── RestrictedActionsMenu
```

The names are **proposals**, not instructions to create duplicate components if equivalents already exist. Extract progressively from `patient-chart.tsx` and `patient-overview.tsx`, preserving behavior with characterization tests. Keep clinical modules responsible for their own mutations.

Use shared `@chartwarden/ui` and Lantern tokens as found in the current checkout. Avoid hard-coded colors, CSS overrides that drift from the design system, new icon sets, and custom widgets where existing components suffice.

## 5. Work packages and PR boundaries

### WP0 — Baseline and design approval (PR 0: docs/tests only)

**Tasks:** Complete G0; draw current and target user journeys; inventory all endpoints and permission gates; capture baseline tests and safe screenshots; write an ADR for chart IA and canonical editor ownership.

**Acceptance:** Every proposed action has a canonical destination and backend owner; unknowns and clinical signoffs are explicit; no application code changes.

### WP1 — Patient discovery and navigation (PR 1)

**Tasks:** Refine census and global search labels, result layout, filters and accessible states; preserve SQL-level caseload narrowing and cursor pagination; stabilize deep links/back behavior; add test coverage for restricted and no-match results.

**Acceptance:** Authorized users find a synthetic patient without PHI in query history; unauthorized users cannot infer restricted patients; old links remain valid.

### WP2 — Patient context header and overview (PR 2)

**Tasks:** Introduce reusable patient context header; standardize patient identity display and status labels; restructure overview into actionable summary with canonical links; add loading/restricted/error states.

**Acceptance:** Correct patient context persists across tabs; no false safety statuses; no new API duplication; no permission regressions.

### WP3 — Demographics, contacts and addresses (PR 3)

**Tasks:** Create read-first Patient details sections; consolidate edit affordances; preserve typed demographics/address routes and field validations; map intake edits to canonical chart data; add unsaved-change and concurrency handling where supported.

**Acceptance:** All authorized edits persist and re-render correctly; rejected/unauthorized changes never appear saved; required fields and audit behavior unchanged.

### WP4 — Coverage, care team, privacy and corrections (PR 4)

**Tasks:** Clarify payer coverage timeline and edits; expose authorized care-team actions; integrate privacy/amendment/merge navigation behind correct permissions; validate patient cross-module updates.

**Acceptance:** No unauthorized action is accessible or accepted; payer void/coverage semantics unchanged; corrections retain audit provenance; cross-module consumers show updated data.

### WP5 — Responsive accessibility, performance and release (PR 5)

**Tasks:** Mobile/tablet pass; keyboard/screen reader/zoom audit; request waterfall measurement and safe optimization; end-to-end clinical journey tests; feature flag or phased rollout if existing infrastructure supports it; rollback playbook.

**Acceptance:** All required regression gates pass; no measurable unauthorized data exposure; no major performance regression; release and rollback tested.

**PR policy:** Small, independently reviewable PRs; do not combine schema rewrites, clinical logic changes and cosmetic changes. If a genuine backend gap is found, propose a separate reviewed contract change with tests and migration/rollback strategy.

## 6. Test matrix (minimum)

| ID | Scenario | Required assertion |
|---|---|---|
| T01 | Census opens with many patients | Server pagination/filtering and stable keyboard navigation |
| T02 | Search for an authorized patient | Correct identity, no PHI search persistence in URL/browser storage |
| T03 | Search for a restricted patient | No patient existence or sensitive details leaked |
| T04 | User changes chart sections | Patient identity context stays correct; deep links work |
| T05 | Rapidly switch between patients | Stale requests cannot render previous patient's details in new context |
| T06 | Missing allergy or code-status data | Unknown is not shown as none/normal |
| T07 | Authorized demographics edit | Server validation, audit behavior, saved data and refresh are correct |
| T08 | Unauthorized demographics edit | No edit UI; backend rejects direct request |
| T09 | Edit fails due to network | Original value retained; no false success; retry safe |
| T10 | Two staff edit same patient | Conflict or defined last-write policy is explicit and tested |
| T11 | Address add/update | Correct patient/tenant; list updates; errors handled |
| T12 | Payer coverage change/void | Correct date ranges, lifecycle and permission enforcement |
| T13 | Caregiver and emergency contact | Roles not conflated; contact fields render correctly |
| T14 | Care-team assignment | Authorized mutation and cross-screen consistency |
| T15 | Patient amendment | Prior value/history preserved per backend contract |
| T16 | Patient merge | Privileged confirmation; duplicate and wrong-patient safeguards |
| T17 | Privacy-restricted chart | ABAC, RLS and backend access rules enforced |
| T18 | Intake → admission → chart | No unexplained duplicate entry; authoritative data consistent |
| T19 | Chart → visits/care plan/documents | Correct patient context; no cross-patient links |
| T20 | Responsive mobile/tablet | No inaccessible actions, clipped content or hidden safety alerts |
| T21 | Accessibility | Keyboard, focus, labels, screen-reader announcements and contrast |
| T22 | Large chart/slow network | Stable skeletons, partial errors, no blank/unresponsive workspace |
| T23 | Audit/telemetry | No PHI in logs, analytics, URL, or browser persistence |
| T24 | Cross-tenant/caseload access | Direct API and deep-link attempts denied consistently |

Use **synthetic patients only** in tests, screenshots and recordings. Test frontend denial *and* backend enforcement. Do not mark integration tests passed when the DB, auth, or test environment was unavailable.

## 7. Clinical, security and data-integrity guardrails

1. HIPAA compliance is not established by UI changes. Maintain minimum necessary access, access logging, transmission/storage safeguards and appropriate organizational controls.
2. Preserve tenant RLS, ABAC caseload restrictions, server permission checks, and not-found-on-deny behavior as implemented. Frontend permission checks are only a usability layer.
3. Avoid PHI in analytics, search URLs, client persistent storage, console logs, error reporting, screenshots and fixtures.
4. Do not alter existing patient identifier, MRN, merge, amendment, code status or privacy semantics without clinical/compliance approval.
5. Maintain separation between **clinical record content** and **administrative demographics**. A demographics save must not silently revise a signed clinical document.
6. Preserve original documents and provenance; do not use an AI-generated summary as authoritative patient identity or diagnosis.
7. Any new endpoint requires schema validation, permission/ABAC tests, tenant isolation tests, audit consideration, idempotency and error contract review.
8. Keep Rust migration boundaries intact: no implicit change to Rust service ownership or API parity contracts.

## 8. Quality gates and execution commands

Claude Code must discover the repository's **actual** package manager and scripts before invoking commands. Do not fabricate successful runs or assume commands from a different commit.

At minimum, run the appropriate equivalents of:

- Formatting/Biome and lint for modified files.
- Typecheck for web app and touched packages.
- Unit/DOM tests for patient census, chart, privacy, identity, search and edits.
- Backend route, permission, ABAC, RLS and tenant-isolation tests where relevant.
- Existing responsive patient-chart E2E plus newly added workflows.
- Accessibility checks on census, chart and edit dialogs.
- Build and route-contract validation.

Document exact commands, environment, commit SHA, pass/fail/blocked counts, and links to artifacts. **Never silently skip failing tests or weaken security tests to obtain green results.**

## 9. Release and rollback

- Ship behind existing feature flags if available, or as small compatible PRs with safe fallback navigation.
- Maintain old route aliases and bookmark compatibility throughout rollout.
- Pilot with synthetic records and representative roles; then approved nonproduction workflows with clinical staff.
- Collect task completion time, wrong-patient near misses, navigation hops, save errors, and user-reported confusion without logging PHI.
- Define rollback per PR: revert UI presentation independently of domain state; avoid irreversible schema changes in this redesign.
- Obtain product, clinical, privacy/security and QA approval before production release.

## 10. Definition of done

- [ ] G0 audit approved with current file:line evidence and actual workflow map.
- [ ] Patient census and global search are consistent and privacy-safe.
- [ ] Chart identity header is persistent, accessible and correct.
- [ ] Users can locate demographics, contacts, coverage and care team without guessing which screen owns them.
- [ ] Editable/read-only/sensitive fields are clearly distinguished and permission-correct.
- [ ] Existing clinical modules remain canonical; no duplicated clinical mutations.
- [ ] Restricted patients remain protected in UI, API, and data access.
- [ ] Intake and admission handoffs lead to the same patient record without contradictory edits.
- [ ] All existing tests pass or have explicitly documented environment blockers; new tests cover critical risks.
- [ ] Mobile, keyboard and screen-reader behavior verified.
- [ ] Rollback and release notes documented; clinical/security signoff recorded.

## 11. Claude Code operating instructions

1. **Start by reading this document and Workflow 02's plan**, plus repository rules (`CLAUDE.md`, `.claude/rules/`, `.agents/rules/`) and existing chart design docs. Do not assume Workflow 02 is merged.
2. Inspect the **current checkout**, not the uploaded ZIP. Print branch, commit SHA, dirty-state and relevant open PRs if available.
3. Complete **G0** and commit only the audit/design artifacts. Stop and request approval before implementation.
4. When approved, execute WP1–WP5 in order; keep PRs narrow and preserve API contracts.
5. Before each PR, report exact touched files, security/clinical implications, test results and rollback plan.
6. When a requirement conflicts with existing backend rules, **stop and escalate**. Never make the UI bypass clinical gates or security enforcement.
7. Treat the patient chart as a **high-risk clinical context**: wrong-patient navigation, stale identity data, privacy leakage and silent saves are release blockers.
8. Do not claim full production readiness based only on static code review or green unit tests.

---

**Final instruction:** The desired outcome is fewer navigation decisions and clearer patient identity/context, **not fewer clinical safeguards**. Make the chart simpler to use without changing the meaning, ownership, or authorization of the underlying patient record.
