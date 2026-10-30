# 00 — Executive summary (interim, session 1)

**This audit is not complete.** No readiness score is assigned (NOT SCORED). Everything below is limited to what was executed.

## What was executed

| Item | Status | Detail |
|---|---|---|
| Route inventory (web/admin/portal) | VERIFIED from source | 356 descriptors in `inventories/routes.csv` (web 299, admin 39, portal 18). Dynamic `:param` routes and the admin/portal apps have **not** been visited. |
| Web static-route baseline sweep, run 1 | PARTIAL | 178 routes visited via in-page SPA navigation as the seeded Administrator. The session ended at about route 100 (`/billing/noe` redirected to `/expired`), so results after that point are **unreliable**. Network/console capture in run 1 was broken (fetch hook missed the app's requests): treat those columns as NOT MEASURED. |
| Flagged-route recheck on a fresh session | VERIFIED | 20 flagged routes revisited; API status read from Resource Timing `responseStatus`. |
| Screenshots | 1 saved baseline (`/billing`) | Not yet filed under `screenshots/` with the audit ID scheme. |
| Forms, tables, dialogs, responsive, a11y, perf, security, clinical workflows, role passes, Pencil diff | **NOT TESTED** | |

## Findings so far

| ID | Sev | Status | Summary |
|---|---|---|---|
| F-001 | P3 | FAILED (reproduced 2×) | While the session is ended, loading `/login` directly redirects to `/expired`; the user must click "Sign in" there. Dead-end feel; also means a bookmarked login URL does not work after expiry. |
| F-002 | P3 | FAILED (reproduced) | Administrator navigation lists screens that the role cannot use: `/platform/cap/constants` and `/reports/admin` return **403** (`/api/v1/platform/cap/constants`, `/api/v1/reporting/admin/mvs`, `/lag`). The UI handles the 403 correctly ("Unavailable — platform-admin only"), so this is a nav-visibility issue only. The 2026-08-07 follow-up (finding A) described the same class. |
| F-003 | P3 | FAILED (reproduced, root cause confirmed in source) | `/subscription/usage` shows "Unavailable — Usage unavailable." for the Administrator. `GET /api/v1/usage/current` returns 404 because the demo org has no subscription (`service-drizzle.ts:585`, `NotFoundError("no subscription for org")`). `usage.tsx:62` turns every error into the same generic message, so "no subscription yet" is indistinguishable from a failure. Evidence: screenshot `/var/folders/3j/5xk46vzs6rb_sgpkv11hf1m00000gn/T/claude-chrome-screenshots-UXTZXB/screenshot-1792713226887-1.jpg`. Regression test: render Usage with a 404 and assert a "no active subscription" empty state. |
| F-004 | P3 | PARTIAL | `/compliance/ai` (`/api/v1/ai/hallucination-reports`) and `/reports` (`/api/v1/reporting/admin/lag`, `/mvs`) make API calls that return 403 for the Administrator on page load. Whether the UI shows an honest state was **not** inspected visually. |
| NF-1 | note | VERIFIED from source | The 404s on `/api/v1/messaging/reminders`, `/messaging/handoffs/policy`, `/messaging/sbar/policy` come from routes that exist in the backend; the web consumer labels the first a feature-flag probe (`use-notification-preferences.ts:52`). Treated as expected until the screens are inspected. |
| F-006 | P3 | FAILED (1 viewport) | Home at 1440×723 (Administrator): five KPI cards wrap 4+1, leaving "Claims Pending" alone on a second row and a gap to its right; the right rail narrows the grid. Evidence `screenshots/WEB-HOME-001-desktop-1440-baseline.jpg`. Other widths not tested. |
| F-007 | P2 | FAILED (1 viewport) | Home "Patients Needing Attention": patient names are truncated ("Samuel O…", "Henry Na…") while the DOB wraps onto three lines; the full name is only recoverable from "My Tasks" beside it. Patient identity truncated in a clinical list. Same screenshot. |
| F-008 | P3 | FAILED (1 viewport) | Patient chart (Rosa Delgado) at 1440: the identity line wraps so "Medicare: …KH49" sits alone after a dangling bullet; the tab strip is clipped at the right edge with "ID…" cut mid-word and no visible overflow affordance (so Documents, Claims, Communications are off-screen). Evidence `screenshots/WEB-PATIENT-CHART-001-desktop-1440-baseline.jpg`. Needs a test with the right rail collapsed and at 1280/1920. |
| F-009 | P1 (mechanism confirmed; harm not demonstrated) | FAILED | Patient chart → Clinical → **Advance Directives** card shows "No advance directive or healthcare DPOA on file." while `GET /api/v1/patients/:id/consents` and `/dpoa/active-primary` both return **404 `NOT_FOUND`** for the Administrator. The backend documents the DPOA route as `200 {data:null}` when none exists, and the 404 comes from the ABAC patient-scope guard (`consent-routes.ts:139,510`, `guards.patientScope(..., "consent_management" / "dpoa_clinical")`), so it is an access denial, not "none recorded". The web swallows the error (`settle()` in `patient-clinical.tsx` ~l.160-175) and renders the empty line (`~l.1169`) when consents is `[]` and dpoa is `null`. **Impact limit:** the local DB has 0 rows in `consent_record` and `consent_record_dpoa_agent`, so the sentence is coincidentally true for this synthetic patient. The defect is that a denied or failed read is shown as a definite clinical negative (DPOA/advance directive in hospice). Not yet shown with the Clinician role or with seeded directive data. Fix: distinguish error/denied from empty ("Not available to your role" / retry), and add a test where the consents call 404s and the card must NOT say "none on file". Evidence: `screenshots/WEB-PATIENT-CLINICAL-001-desktop-1440-advance-directives.jpg` (to be filed) and the response bodies above. The same pattern probably affects the PPS "—" cells (that 404 is a legitimate "assessment not found"). |
| F-008b | P3 | CONFIRMED (root cause) | The chart tab strip is `nav.wx-chart-tabs.wx-no-scrollbar`, `scrollWidth 1294` in `clientWidth 940`, `overflow-x: auto`: 354 px of tabs (part of Visits, IDG, Documents, Claims, Communication) are reachable only by scrolling a hidden scrollbar. Tabs are real links in `nav[aria-label="Patient chart"]` (acceptable semantics; not an ARIA tablist). "Clinical" (`?view=clinical`) and "Communication" (`/messaging`) are the only two that don't share the `/patients/:id/<tab>` pattern, so Communication leaves the chart (patient context carried: "Rosa Delgado · Care Team"). |
| F-010 | P4 | observation | On the Clinical tab the right rail repeats name, DOB, sex, MRN and Medicare already in the chart header (screenshot above) and is the cause of the header narrowing that wraps "Medicare" (F-008). |
| F-011 | P2 | FAILED | **New medication order** (`/patients/:id/medications/new`, page not dialog) shows **no patient identity** (no name, DOB or MRN anywhere in `main`; checked by text search; there is no patient banner element). The only hint is the placeholder "Search this patient's admissions…". A prescriber entering an order cannot confirm whom it is for from this screen. **Widened by a 12-page check** (text search of `main` for name/MRN/DOB, patient Rosa Delgado): identity is shown on orders, assessments, encounters, consents/new, privacy, admission, discharge, HOPE (name only), level-of-care/new; it is **missing on `/patients/:id/medications/new`, `/assessments/summary` and `/assessments/changes`** (the last two may be intentionally sub-views; unconfirmed). Evidence `screenshots/WEB-MEDICATION-NEW-001-desktop-1440-no-patient-banner.jpg`. Wrong-patient risk on a clinical order screen; also check the other `/…/new` order/encounter pages. |
| F-012 | P2 | FAILED | Empty **Save draft** on the same page sends `POST /api/v1/medication-orders` immediately: no client-side validation, 0 `aria-invalid`, no required attributes on 27 fields, focus drops to `<body>`. The server answered **403**; the UI shows "Draft could not be saved. Please check the fields and try again." Source (`medication-order-editor.tsx` l.378-384) shows that *any* error without parseable field findings, including a 403, gets that "check the fields" text, so a permission or CSRF failure is presented as a user-fixable input problem. **Not determined:** why this 403 occurred (permission vs CSRF vs validation); my own POST lacked the app's CSRF header so it proves nothing. No order was created. |
| F-013 | P3 (A, WCAG 2.4.2) | CONFIRMED (app-wide, observed on every route visited) | `document.title` is the constant "ChartWarden" on every screen, so history, tabs and screen readers cannot tell pages apart. |
| F-014 | P3 | observation | Administrator sees **New Medication / Prescribe / Reconcile** actions on the medications tab; whether the role may use them is unconfirmed (see F-012). Same class as F-002. |
| F-015 | P2 | FAILED | **Two different patient headers inside one chart.** Variant A (Overview, Clinical, Plan of Care, Orders, Medications, IDG, Documents, Claims): name, status, "DOB Jun 28, 1951 (75y) • Female • MRN: …1E69 • Medicare: …KH49" (MRN and Medicare **masked**) with a "Patient Summary" right rail. Variant B (Election & Certification, Visits, Assessments): avatar, name, **full MRN `MRN-FCE50CE41E69`** in a chip, "DOB 1951-06-28 · 75y" (ISO), no rail. Same patient, different component, different PHI masking and date format on 3 of 12 tabs. If masking is a deliberate control it is bypassed on those tabs; repo history shows a 2026-10-19 commit "show the stored MRN verbatim", so intent is unclear. Evidence `WEB-PATIENT-ELECTION-001-…header-variant-b.jpg`, `…ASSESSMENTS-001-…`, `…VISITS-001-…`. |
| F-016 | P2 | FAILED | **Notice of Rights shows three states.** Documents tab lists a "Notice of Right" PDF uploaded 10/22/2026 (type shown as the raw code "Nor"); the same tab's Key Documents panel says Notice of Rights "No upload"; the Election tab's compliance windows say "Notice Of Rights — Closed (due 2026-10-24)". A user cannot tell whether the notice is on file. Likely causes (unconfirmed): the doc type code `NOR` is not mapped to the Key Documents slot; the title is misspelled "Right". Evidence `WEB-PATIENT-DOCUMENTS-001-…notice-of-rights.jpg`. Also the list shows a "Transfer Summary — Discharge Summary Transfer" for a patient who is Active (admitted 2026-10-21); may be seed data. |
| F-017 | P3 | FAILED | **Acronyms are title-cased wrongly:** care team and IDG role "Rn" (should be RN) for "Dana Kim, LPN"; "Hospice Md · Pending attestation" on the Election tab; raw type code "Nor" in the Documents row. The IDG row also pairs the name suffix LPN with the role "Rn", which contradicts itself; whether that is data or a mapping bug is unconfirmed. Evidence `WEB-PATIENT-IDG-001-…role-casing.jpg`. |
| F-018 | P3 | FAILED | **Visits tab layout:** the "Encounter detail" pane renders at the bottom-left, flush against the sidebar edge and outside the content padding, with the filter and "New Encounter" button crowded beside the title. Evidence `WEB-PATIENT-VISITS-001-…detail-pane-misplaced.jpg`. **Election tab:** the "Statement type" label sits on the first row while its value "Structured" wraps to the next row at the left, detached from its label. Evidence `…ELECTION-001-…`. |
| F-019 | P3 | FAILED | The Orders tab has a second tab strip (Orders, Laboratory, DME, Comfort Kits, Supplies, Services, Level of Care, Recertification, "IDG Requests…") that is clipped at the right edge, like F-008b. The main chart strip is also clipped on Variant A tabs ("ID…") and on Variant B ("Commu…"). Evidence `WEB-PATIENT-ORDERS-001-…clipped-subtabs.jpg`. |
| NF-3 | escalate to qualified reviewer | observation | Election tab data for Rosa Delgado: **Admitted 2026-10-21, Activated 2026-10-22, election effective 2026-08-03, election signed 2026-10-22**, Benefit Period 2 active (2026-08-03 to 2026-10-31, "Day 82 of 89") with CTI recertification "Missing". An election effective ~80 days before admission and signed after it, with Period 2 as the first period shown, is internally odd. May be a seeded scenario; **not asserting regulatory compliance or non-compliance**. The screen also quotes "42 CFR 418.24(b)(6)" in the Addendum notice; that citation was not verified. |
| NF-4 | note | observation | Four date formats on one patient's chart: `2026-08-03`, `08/03/2026`, `Oct 22, 2026`, `10/22/2026`. |
| NF-5 | note | observation | Claims tab: the "Paid Claims $0" card's subtitle reads "Expected payment · 0 paid" and "Pending" reads "0 awaiting payment", so the subtitles look swapped or confusing. Orders tab: "Pending Signature 0 — Physician review needed" reads as if action is needed when the count is 0. Both are copy-level and unconfirmed against the spec. |
| F-020 | P2 | CONFIRMED (source + live, both roles) | The sidebar item **Care Plans** is hard-wired to `/bereavement` (`apps/web/src/shell/primary-nav.ts` `key: "care-plans", to: "/bereavement"`, claims `/bereavement`, `/admin/volunteer`). Its only children are Bereavement Program and Bereavement Intake. A clinician looking for care plans lands on "Bereavement Caseload", which for the seeded Clinician shows "Unavailable — Your bereavement caseload could not be loaded." There is no global care-plan screen in the navigation; care plans exist only inside a patient chart. Evidence `WEB-CLINICIAN-CAREPLANS-NAV-001-desktop-1440-bereavement.jpg`. |
| F-021 | P2 | FAILED | **Clinician census cards contradict the list.** Seeded Clinician (no caseload): cards read "Active census 3 — 6 total in organization", "Discharges 2", "Recerts due 1", while the table reads "0 loaded — No patients are visible in the current census." Cards show org-wide aggregates while the list is caseload-scoped, so the same screen gives two different truths, and a count the user cannot open ("Recerts due 1"). Evidence `WEB-CLINICIAN-CENSUS-001-desktop-1440-cards-vs-empty-list.jpg`. |
| P-1 | PASS | VERIFIED | **Patient access boundary, UI level:** as the Clinician, `/patients/<Rosa Delgado id>` shows "Patient not found — This patient does not exist or is outside your access." (does not confirm existence; clear wording). Server-side behaviour of the underlying API calls for that patient as Clinician was not tested directly. |
| F-009u | update | PARTIAL | The Clinician pass could not exercise F-009: the Clinician has no caseload, and the DB holds **0** consent/DPOA rows, so even a permitted role would see the same sentence. Proving harm needs (a) a seeded directive and (b) a role that is denied. Until then F-009 stays "mechanism confirmed, harm not demonstrated". |
| NF-6 | note | VERIFIED | Login password field's dots are a `placeholder` on an empty value (not autofill). It looks filled at a glance; consider a plain-text placeholder. Closes the earlier unverified item. Actor menu holds a single item, "Sign out". |
| NF-2 | note | observation | Names are formatted "Last, First" on Patients·Census and "First Last" on Home and the chart; the census also shows "Patient <8-hex>" under each name. Cross-module consistency item, not yet judged. |
| DA-1 | decision | RESOLVED | User decision 2026-10-22: primary `#1a56eb` is authoritative. `DESIGN.md` colour section is stale (doc-drift D-1). See 02. |
| DA-2 | decision | OPEN | Mockup PNGs unavailable (see 02). |
| U-1 | unresolved, potentially P1 | NOT DIAGNOSED | The session ended unexpectedly **three** times during automated navigation (sweep 1 at `/billing/noe`; sweep 3 at `/work/cosignatures` where `GET /api/v1/encounters/cosignature-queue` returned 401 and the app redirected to `/expired`). Policy (`packages/types/src/policy/session-policy.ts`): staff idle 15 min, 8 h work window, 24 h hard cap; `last_activity_at` is touched at most once a minute. Local `session` rows (timestamps only): one browser session lived ~3 min of recorded activity (23:44:02 to 23:47:18), another ~25 min (23:47:41 to 00:13:00); neither matches the 15 min idle or the absolute caps. No seed scripts were running at the time (only browser sessions in the last 45 min; scripts created sessions earlier, at 22:53 and 23:12). Not route-specific: `/billing` and `/work/cosignatures` both load fine on a fresh load, and a later 44-route sweep ran 80 s without incident. If a clinician's session can end during active use, that is a P1 data-loss risk (unsaved notes). Needs a controlled repro: sign in, work steadily, log the timestamp of the first 401, and compare against `session.last_activity_at`. Also unexplained: new browser sessions appeared at 00:13:31 and 00:13:44 without my signing in. |
| F-005 | P3 | PARTIAL | `/bereavement` and `/bereavement/supervisor` call `/api/v1/bereavement/dashboard/counselor` and `/supervisor`, both 403 for the Administrator; the screens show "Unavailable …" copy and render no `h1`. Same nav-visibility class as F-002; visual state not yet inspected. |

## Claims I am explicitly NOT making

- The "Denied", "Could not load" and `/billing/noe` signals from run 1 were **false positives**: the first is a "Denied" KPI label, the rest vanished on a fresh session (they came from the expired session). They are not findings.
- Zero console errors / zero failed requests in run 1 is **not** evidence of a clean app.
- `/telehealth` and `/subscription` render the Administration tab strip as their leading text; I have not looked at them visually, so no verdict.
- Whether the login password field shows pre-filled dots (seen in one screenshot) is a placeholder or autofill: NOT VERIFIED.

## Clinician route sweep (178 static web routes, 00:38:00–00:42:28, one session)

Load-state check only (page renders, API statuses). Not interaction or fidelity coverage.

- **S-1 (observation):** no redirects, no unexpected `/expired`; the sweep ran 4m28s on one session. U-1 was **not reproduced** in this window; it stays open.
- **S-2:** 76 of 178 routes had at least one API 4xx for the Clinician. 71 of those show a denial or "Unavailable" state; 80 routes show a denial state in all.
- **S-3 (P3, candidate F-022):** 20 routes render no `h1`; most show a generic "Unavailable" panel (e.g. `/roles`, `/bereavement`, `/billing/rule-config`, `/medicaid/billing/ar-dashboard`). The Clinician sees nav entries and URLs for screens they cannot use (same pattern as F-002, now confirmed for a second role).
- **S-4 (P3):** 13 denial panels use the generic word "Unavailable" with wording that mixes denial and outage ("you may lack billing visibility"). Not distinguishable from a server failure.
- **S-5 (needs follow-up):** 5 routes had 4xx API calls but no denial state: `/supplies`, `/documents`, `/subscription/plan`, `/messaging/preferences`, `/messaging/saved-replies`. Each needs a visual check to see whether a failure is silently hidden (same family as F-009).
- **S-6:** non-403 errors were 404s on `/hope/schedules`, `/hope/submissions`, `/hope/dashboard/compliance`, `/patients/:id`, `/messaging/reminders`. Not yet classified (empty-state 404 vs missing data vs access-scoped 404).
- `/supplies/par-stock` renders the Orders tab strip text ("Awaiting Signature, Verbal Orders…") with no h1: possible wrong-screen render, to verify.

Raw rows remain in browser `sessionStorage.__clin` (not exported).

## S-5 follow-up: five silent-failure routes, visual check as Clinician (00:5x UTC)

Screenshots were viewed live, not saved to `screenshots/`. Rows below are what was observed.

| Route | API 4xx | What the screen shows | Verdict |
|---|---|---|---|
| `/supplies` | 403 `/supplies/par-stock` (x2) | KPI "Shelf critical / empty 0"; "Every active shelf row is at or above its reorder point — or you do not hold `par_stock.read`…"; "No comfort kit has been dispatched — or you do not hold `comfort_kit.dispatch.read`" | **FAILED (F-022, P2):** a denied read is shown as a zero/"all fine" fact. The copy itself admits it cannot tell the cases apart, and shows raw permission codes to the user. Same mechanism as F-009, lower stakes (stock, not directive). |
| `/documents` | 404 `/patients/:id` (x6) | 21 org documents listed with every Patient cell reading just "Patient" | **PARTIAL (F-023, P2, needs authorization review):** the list returns org-wide patient documents to a Clinician whose chart access to Rosa is denied (P-1), while per-row patient lookups 404. Names lost; links lead to "not found". Whether the list should be caseload-scoped is a policy question for a qualified reviewer; no violation asserted. |
| `/subscription/plan` | 403 `/subscription` (x2) | "No plans are available for your account." | **FAILED (F-024, P3):** a 403 is presented as an empty state. |
| `/messaging/preferences` | 404 `/messaging/reminders` | "Notification preferences are not turned on for your organization." | **VERIFIED honest-enough (NF-1):** consistent with the known feature-flag probe; flag state itself not checked. |
| `/messaging/saved-replies` | 403 `/messaging/template-admin` | Personal saved-replies panel renders with empty state and add form | **PARTIAL:** the 403 is the org-template probe; the personal list status was not separately checked. No defect observed. Add-reply not submitted. |

Also seen: Clinician nav shows Administration with Prescribers, Prescribing Policy, Volunteer Compliance, EVV Metrics (F-002 pattern, role not yet verified against permissions).

## Compliance Auditor pass (seeded `avery`, local synthetic account)

**Tooling correction.** The first auditor sweep (120 routes) recorded zero API errors. That was a tooling fault: the browser resource-timing buffer fills on the Vite dev pages and silently drops later entries. Those results were discarded. The sweep was re-run on all 178 routes with the buffer cleared per route and the filter set to `/api/v1` (00:58:04–01:03:35, one session, no expiry). The Admin and Clinician sweeps captured statuses, but the same buffer limit was not ruled out for them; treat their "no 4xx" rows as unconfirmed.

- **A-1 (positive):** Home is honest for this role: "No census or A/R data", "The HOPE worklist is not available for your access scope". The nav is reduced to Home, Admissions, Assessments, Medications, Scheduling, Administration, Visits, Communications, Audit Log, Settings.
- **A-2:** 141 of 178 routes returned a 4xx (all 403 except 404s on `/hope/submissions` and `/hope/dashboard/compliance`) and 141 show a denial/"Unavailable" state. The two sets match on all but three routes. Denials are visible, but the copy mixes causes: "you may lack provider scope, or the read seam is unbound" (`/remittance`), "the billing read seam is not bound, or you lack scope" (`/billing/claims`). A user cannot tell permission from outage, and internal terms ("read seam") reach the screen.
- **F-025 (P2, needs authorization review):** the auditor can open and edit create/entry forms with no API call on load: `/triage/intake` ("Take a call"), `/safety/incidents/new` ("Report a Safety Incident"), `/referrals/new`, `/admissions/new`, `/billing/claims/new`, `/medicaid/billing/claims/new`, `/triage/paper-reentry`. **Submission was NOT TESTED** (would create records). If the API refuses on submit, a read-only role fills a form to a late failure (same family as F-012); if it accepts, that is an authorization issue. Needs a qualified reviewer and a safe test.
- **F-026 (P3):** wrong active nav item: on `/triage/intake` and `/safety/incidents/new` the sidebar highlights "Visits".
- **F-027 (P3):** entry forms require raw IDs ("Provider entity id", "Patient id", "Admission id", "Clinician membership ID") with no lookup.
- **F-028 (P3):** `/remittance` shows "835 Advices" as a number while the worklist is unavailable and the other KPIs show "—". Partial data beside a denial (F-021 family). Whether the count is within this role's entitlement is for the reviewer.
- **A-3:** silent 4xx with no banner: `/idg/schedule` (403 on `care-team-staff`), `/subscription/plan` (same as F-024).
- **A-4 (to review, not asserted):** pages that loaded with data for this role include messaging governance (`break-glass`, `retention`, `export-approvals`, `message exports`), `/admin/setup`, `/admin/prescribers`. Consistent with an auditor role, but the seeded role has 99 keys; whether each is intended is a policy question.
- **F-001 reproduced:** after the session ended, `/login` redirected to "Your session ended".

### U-1 evidence (fourth unexpected ending)
- Signed in 00:47:22; sweep ran steadily; browser showed "Your session ended" at about 00:53:2x.
- DB: that session's `last_activity_at` = 00:53:17 (seconds before), `expires_at` 3 days after creation. A **new session row for the same user was created at 00:53:20** that nobody signed in to by hand. The same pattern exists for `admin`: a new row at 00:13:32, seconds after the old row's last activity (00:13:01).
- Mismatches to the documented policy (15 min idle, 8 h window, 24 h hard cap): `expires_at` is 3 days for these sessions.
- Hypothesis only: something replaces the session (rotation or re-mint) and requests carrying the old cookie then fail into `/expired`. A source search for rotate/renew in `packages/auth` and the web shell found nothing that does this. Not confirmed; needs a controlled repro and a read of the sign-in/org-selection path (org selection did not create an extra row on this sign-in).
- A later session of about 10 minutes (and a 5.5-minute sweep) did not end.

## Organization Administrator pass (seeded `orgadmin`, role label "Administrator")

Full 178-route sweep, 01:04:56–01:10:22, one session, buffer-corrected method, no redirects, no expiry. Home shows live data (3 active patients, 16 HOPE assessments due, 24-item bell badge, patients needing attention).

- **O-1:** only 7 routes returned a 4xx: `/admissions` (404 on `/admissions/:id` and `/admissions/:id/readiness`), `/bereavement` and `/bereavement/supervisor` (403, as F-005), `/platform/cap/constants` (403, F-002 again), `/subscription/usage` (404, F-003 again), `/messaging/preferences` (404 `reminders`, NF-1), `/messaging/saved-replies` (404 `sbar/policy`, `handoffs/policy`; flag probes).
- **F-029 (P3, candidate bug):** the Admissions list page requests a **detail** and **readiness** endpoint with an id (`/admissions/:id`, `/admissions/:id/readiness`) and gets 404. The list page should not be asking for one admission; either a stale/undefined id is being sent or a row preview is fetched for a missing record. Cause not determined.
- **O-2:** the keyword classifier flagged 16 "banner without 4xx" routes (e.g. `/billing`, `/supplies`, `/subscription`); the sample snippets are normal page copy. These are classifier false positives, **not** findings. Banner detection is a heuristic and is not coverage.
- **O-3:** 7 routes render no `h1` (`/bereavement`, `/bereavement/supervisor`, `/platform/cap/constants`, `/subscription`, `/subscription/plan`, `/subscription/usage`, `/subscription/promos`): the same unavailable-panel pattern as S-3, here for a role that can see the whole nav.
- Sign-out from the actor menu returns directly to `/login` (no `/expired`), so F-001 is specific to ended sessions.

## Role-pass summary (load-state only)

| Role | Routes | 4xx routes | Session ended during sweep |
|---|---|---|---|
| Administrator (earlier, unconfirmed buffer) | 167 | see F-002..F-005 | once (U-1) |
| Clinician | 178 | 76 | no (4m28s) |
| Compliance Auditor (corrected) | 178 | 141 | no (5m31s); an earlier 120-route run ended at ~6 min (U-1) |
| Org Administrator (corrected) | 178 | 7 | no (5m26s) |

## Administrator and Clinician sweeps re-run (buffer-corrected method)

Method: `performance.clearResourceTimings()` per route, filter `/api/v1`, 178 static web routes, one session each.

**Clinician (01:22:37–01:28:05, no expiry, no redirects).** Identical to the first run: 76 routes with a 4xx, the same five non-403 404s (`hope/schedules`, `hope/submissions`, `hope/dashboard/compliance`, `patients/:id`, `messaging/reminders`), 19 routes with no `h1`. The first Clinician run's numbers stand; the buffer fault did not affect them. Silent-failure set from this run: `/documents`, `/subscription/plan`, `/messaging/preferences`, `/messaging/saved-replies` (`/supplies` is now caught by the banner heuristic because its copy contains "you do not hold"; it was visually confirmed as F-022 regardless).

**Administrator (01:16:14–01:21:41).** All 178 routes completed. 11 routes with a 4xx: `/bereavement`, `/bereavement/supervisor` (403, F-005), `/platform/cap/constants` (403, F-002), `/compliance/ai` (403 `ai/hallucination-reports`, F-004), `/reports` and `/reports/admin` (403 `reporting/admin/*`, F-002/F-004), `/subscription/usage` (404, F-003), `/messaging` (404 `channels/:id/snooze`), `/messaging/preferences` and `/messaging/saved-replies` (404 flag probes, NF-1), and `/mdm` (401, see below). 19 routes made no API call; 8 render no `h1`. F-002 to F-005 are **confirmed** under the corrected method. New: `/messaging` requests a `snooze` endpoint for a channel id and gets 404 (candidate F-030, cause not determined, same family as F-029).

**U-1, fifth ending.** The Administrator session (created 01:15:51, last activity 01:20:57) ended during the final route, `/mdm`, with a 401, after 5m46s. A new `admin` session row was created at 01:21:37 and never used (`last_activity_at` = `created_at`). Same signature as `avery` (00:47:22 → ended ~00:53:20, new row 00:53:20) and the earlier `admin` rows (new row 00:13:32 right after the old row's last activity 00:13:01).
Counter-evidence: the Clinician session (01:22:13) was still active at 6m02s, and an Org Admin sweep of 5m26s did not end. So this is **not** a fixed 5m50s limit. Leads, unverified: the RBAC permission cache TTL is 5 minutes (`packages/auth/src/rbac/cache.ts:62`, `resolve.ts:102`); `session.expires_at` is 3 days rather than the documented 24 h hard cap; a new session row is minted at the moment of the ending. U-1 remains **open** and needs a controlled repro with server logs.

## U-1 RESOLVED (mechanism reproduced): screen-lock "Unlock" ends the session — F-031

**F-031 (P1 usability / possible clinical data-loss; reproduced live, no code changed).** After 5 minutes without real input the web app shows the "Locked" overlay. Entering the password and pressing **Unlock** does not unlock the session; it silently ends it. The next org-scoped request returns 401 and the user lands on "Your session ended", and in-progress drafts are cleared.

Evidence chain
1. `apps/web/src/modules/02-identity/screen-lock.tsx:5` says "the SESSION STAYS ALIVE"; `IDLE_MS` = `SESSION_POLICY.screenLockSec` = 5 min (`packages/types/src/policy/session-policy.ts:99`), re-armed only by `mousemove/mousedown/keydown/scroll/touchstart`.
2. `unlock()` (`screen-lock.tsx:90-93`) calls `authClient.signIn.email(...)`. That is a **fresh sign-in**, which mints a **new `session` row**. Org binding happens only in the separate `POST /api/v1/auth/select-organization` step (`organization-select.tsx:132`); `unlock()` never calls it.
3. DB, every ending: the old row is org-bound (`active_organization_id` set) and is abandoned; the new row has **no organization**. Rows: `admin` 23:44:02, 00:13:32, 01:21:37; `avery` 00:53:20; `casey` 01:35:46 — all `org_bound = f`, created seconds after the last activity of the previous row.
4. API log: `POST /api/auth/sign-in/email` then `GET /api/auth/get-session` (the exact `unlock()` pair), then 401s three seconds later. `authenticate.ts:221` returns early for a pre-org session, so org-scoped routes get no `organizationId` and throw `UnauthorizedError` (e.g. `mdm-routes.ts:53`).
5. `global-response-signal.ts:37-43`: **any** 401 from **any** request is treated as session death → `/expired`, and `clearAllDrafts()` runs (`:106`).
6. **Controlled repro (Clinician, 01:35):** let the lock appear, entered the seeded password, Unlock: the page still showed its already-loaded data; a navigation to `/orders` returned 401 on `/api/v1/orders/pending-signature` and landed on "Your session ended". New DB row `casey 01:35:46 org_bound=f`.
7. Why tests miss it: `screen-lock.dom.test.tsx` mocks `authClient`, so the real sign-in → org-less session path is never exercised.

Impact: a clinician who steps away for 5 minutes and unlocks loses the session and any unsaved ceremony drafts, with no explanation beyond "for your security, you were signed out". The lock is not a soft re-auth; it is a forced sign-out with a misleading overlay.
Remediation direction (not applied; audit only): re-bind the active organization after the unlock sign-in, or verify the password without minting a session (step-up style), and add a live (non-mocked) test.

Corrections to earlier U-1 notes
- The RBAC 5-minute cache and the `expires_at` of 3 days are **not** the cause. `expires_at` is Better Auth's documented outer cap (72 h, `session-timeout.ts:23-29`); the per-request enforcer applies the 15 min idle / 8 h / 24 h policy.
- The "~5m50s" figure was the 5-minute idle lock plus the time to reach the next org-scoped request, not a hard timer.
- **Not established:** who submitted the unlock form in the earlier endings. The API log shows a failed sign-in at 00:52:40 and a successful one at 00:53:20 for `avery`, which looks like a person typing a password into the lock overlay. That input was not produced by the sweep scripts; whoever was at the keyboard is not known to the audit. The defect stands regardless of who unlocked.
- This also explains why sweeps that were driven with real clicks, or finished before 5 minutes of input idle, did not end.

## F-025 safe probe (Compliance Auditor, empty-body POSTs, no records created)

Method: signed in as the seeded auditor on localhost; sent `POST {}` with the app's own `X-CSRF-Token` header to the create endpoints the forms use. An empty body cannot create a row; a permission denial arrives before validation.

| Endpoint | Result |
|---|---|
| `POST /api/v1/referrals` | 403 `requires permission 'referral.create'` |
| `POST /api/v1/admissions` | 403 `requires permission 'admission.create'` |
| `POST /api/v1/safety/incidents` | 403 `requires permission 'safety_incident.create'` |
| claims, medicaid claims, triage intake, paper re-entry | NOT TESTED (my guessed paths returned 404; real endpoints not yet mapped) |

**Verdict:** server-side authorization holds for the three tested paths, so F-025 is **not a data-integrity or authorization defect there**. It stays a P3 UX defect: the auditor can open and fill forms that can only fail on submit (and F-009-style raw 403 text is shown). Full UI submission was NOT TESTED.

## Admin app (:5175) pass

- AD-1 (VERIFIED, good): as Compliance Auditor, `/` lands on a clean `/403` page, "limited to platform-ops staff", with a "Go home" button. Denial state is correct. The shared `localhost` cookie carried the web session across ports.
- AD-2: signed in as seeded Organization Administrator (holds `platform_ops`), selected org, reached the "Platform operations" overview.
- Static sweep: 28 of 28 static admin routes (the 11 `:param` routes are NOT TESTED) rendered an h1, no redirects, no horizontal overflow, **zero 4xx/5xx** on any `/api/*` call. Billing pages use a second API prefix `/api/admin/*`; my first pass filtered `/api/v1` only and showed `n=0` for them, so it was re-run with `/api/` and came back clean. Tooling note: filter on `/api/`, not `/api/v1`, in the admin app.
- Spot visuals: `/admin/plans` shows "No plans yet. Create the first plan to begin." and `/admin/revenue` shows $0.00 MRR/ARR with "run a recompute": clean empty states on a seed with no plans.
- Scope limits: load-state only; no interactions, forms, dialogs or role variants (Administrator `sysadmin` has no platform_ops, so its denial was not re-checked here).

## Portal (:5174/portal/) pass: signed-out state only

Scope: no portal account is seeded and I did not create one or send an invitation, so every signed-in portal screen is **BLOCKED**. Tested: the sign-in page, token-link pages and protected URLs with no session (staff cookie cleared first; an earlier run with a staff cookie present returned 403 instead of 401 and was discarded as confounded).

- VERIFIED: `/portal/` shows the sign-in page (Email link / Password tabs). `/accept-invitation`, `/funeral/redeem`, `/collaborator/redeem` without a token show "This link can't be used". `/portal/signed-in` with no session returns to Sign in.
- **F-032 (P2) Signed-out visit to a protected portal page renders the full shell instead of redirecting.** `/portal/p/:id`, `/care-plan`, `/messages`, `/account`, `/patient-picker`, `/funeral/case` all return 401 on their API calls, yet the page shows the nav, "Viewing care for Patient unavailable" and per-card "Your session has ended. Please sign in again." with a **Try again** button that cannot succeed. No redirect or Sign-in link. (Contrast with web, which redirects on any 401.) Needs a product call on the intended behaviour; evidence: screenshot of `/portal/p/:id`, API statuses above.
- **F-033 (P3) Unknown portal URL shows the router's default error page** ("Unexpected Application Error! 404 Not Found … Hey developer … provide your own ErrorBoundary or errorElement"), unthemed, white text on dark, no navigation. The portal route tree has no `errorElement`/catch-all. Developer-facing text can reach a family member.
- Not tested: signed-in routes (`/p/:id/*` content, telehealth, amendments, bereavement), magic-link and password flows, step-up, PWA/offline, mobile widths.

## Chart, responsive, accessibility, security and S-6 pass (session 1, later)

Second patient (Okonkwo, active) as Administrator. Window widths 1440/1280/1024/768/500 (Chrome will not go below 500 px, so true phone width is NOT TESTED).

- **F-034 (P1, responsive, VERIFIED at 1024 and 768 with screenshot `screenshots/WEB-CHART-F034-tabstrip-hidden-768.jpg`; 500 px by hit-test only):** below about 1280 px the patient-chart tab strip is not reachable. `elementFromPoint` at the strip's centre returns the right-rail content, not the tabs, and the first viewport shows banner then rail. Computed styles: `.wx-patient-banner` is `position:sticky; top:0; z-index:2; height:145px` and `.wx-chart-tabs` is `position:sticky; top:0; z-index:1`, so two elements stick to the same offset and the banner wins. At 1280 and above the strip is hit-testable. Cause is inferred from computed styles, not from reading the CSS source.
- **F-035 (P3):** at 1440 the chart tab strip is 1294 px wide inside a 940 px container (`overflow-x:auto`, scrollbar hidden by `wx-no-scrollbar`), so Claims and Communication sit off-screen with only a half-clipped "IDG" as a cue. The Orders sub-tab strip is 911 px in 892 px. Matches earlier NF items on the strip; now measured on a second patient.
- **F-036 (P3):** the "Communication" chart tab links to the same URL as Overview, and "Visits" and "Start Visit" share `/encounters`. A tab that goes nowhere new reads as broken.
- **F-037 (P3, a11y):** six chart pages (overview, orders, medications, documents, claims and the `view=` panes) have no `<h1>`; the patient name is the only candidate and is not a heading. `/patients/:id` also has 14 interactive targets under 24 px (WCAG 2.5.8 is advisory, not a certification claim).
- Chart tab load state, second patient: 14 chart URLs, 0 API errors except `?view=clinical` (404 on `scales/pps/latest`, `consents`, `dpoa/active-primary`, the same absence-as-404 family as F-009). `/privacy` has no tab strip (F-008b again). The 8 Orders sub-tabs load with no errors, but every one shows the same "Needs Attention" heading, so I cannot prove each pane differs: PARTIAL.
- Responsive document overflow: none at 1280 and 768. At 768 `/admin/staff` has 77 px of table content past the viewport inside the table scroller (expected; no visible scroll cue was checked).
- A11y heuristics (10 routes, DOM-level, not axe): 0 unnamed controls, 0 unlabeled visible inputs, 0 images without `alt`, 0 heading-level skips, one `<main>`, `lang=en`. Keyboard order, focus visibility, screen-reader output and contrast were NOT TESTED.
- Security/privacy (local, dev server): API sends CSP (`default-src 'self'`, `frame-ancestors 'none'`), HSTS, nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; the CSRF double-submit check rejected an unheadered POST (403 `CSRF_VALIDATION_FAILED`) and the server enforced the permission after it. Browser storage holds only the theme key (no PHI), IndexedDB empty, no service worker. The session cookie is not script-readable. A script-readable `JSESSIONID` cookie exists on `localhost`; it is not set by this repo (no source match), and cookies are shared across ports, so I treat it as another local app, NOT a finding. Not tested: production headers (dev server), rate limiting, XSS probes, upload handling.
- Performance: NOT TESTED (Vite dev build, so numbers would not describe production).
- **S-6 classified.** The routes behind the 404s (`hope/schedules`, `hope/submissions`, `hope/dashboard/compliance`, `messaging/reminders`, `patients/:id`, `channels/:id/snooze`, `admissions/:id/readiness`) all exist in backend source, and an unauthenticated probe returns 401 for each versus a plain 404 for a control path (`/hope/nonexistent-zz`). So these are not missing routes; they are record-level "not found" answers. Remaining question for engineering: whether the UI should treat them as empty. Individual response bodies were not captured, so which request returned which 404 is PARTIAL.
- Raw sweep rows exported to `inventories/sweep-raw-*.json` (snippets removed); `inventories/README-sweep-raw.md` says which files are valid.

## Form submission pass (Administrator, local seeded stack, synthetic data)

Scope decision: submitted ONE record, a referral named "AUDIT-TEST Synthetic" (reason "Synthetic audit test record - safe to delete"). Not submitted, per the directive: claims, orders, medications, prescriptions. Safety incident, admission, triage intake were exercised to their validation gate only.

| Form | Test | Result |
|---|---|---|
| `/referrals/new` | empty submit | VERIFIED: "Patient full name is required.", 0 API calls |
| `/referrals/new` | valid submit (name + reason) | VERIFIED: created, redirected to detail (`referrals/ea732c9c-...`), status New, "Patient match: Not resolved", readiness panel explains what is missing |
| `/safety/incidents/new` | empty Continue | VERIFIED: stays on step 1, validation shown, 0 API calls; submission NOT TESTED |
| `/admissions/new` | wizard gating | VERIFIED: steps 2 and 3 disabled until step 1 valid; submission NOT TESTED |
| `/triage/intake` | gating | VERIFIED: "Open the call" disabled until valid; submission NOT TESTED |
| `/billing/claims/new`, `/medicaid/billing/claims/new` | gating | VERIFIED: Next/Continue disabled until the first step is valid; submission NOT TESTED (directive forbids claims) |
| `/triage/paper-reentry` | render | page shows explanatory text but no fields or buttons were found for the Administrator (BLOCKED or PARTIAL; may be gated on continuity evidence; not investigated) |

- **F-038 (P2, data integrity, reproduced): "Received at" on New Referral defaults to the UTC wall clock but is read as local time.** At 19:15 PDT (02:15 UTC) the field was pre-filled `2026-10-23T02:15`. After submit, the API stored `receivedAt = 2026-10-23T09:14:00Z`, seven hours in the future, and the detail page shows "Received Oct 23, 2026, 2:14 AM" for a record created on the evening of Oct 22. Cause in source: `apps/web/src/modules/06-admission/referral-new.tsx:37` uses `new Date().toISOString().slice(0, 16)`. The same pattern (found by grep, NOT run) is at `15-discipline-care-plans/aide-poc-view.tsx:72`, `15-discipline-care-plans/assessment-editor.tsx:77` and `11-orders/order-editor.tsx:71`; other modules (eMAR administer, IV segment, HOPE capture, remittance appeal) already subtract the timezone offset correctly, so a correct helper exists in the repo. The offset equals the user's UTC offset, so it is invisible in UTC and wrong everywhere else. Clinical or billing timing consequences are for qualified reviewers.
- Cleanup: the test referral remains in the local database. I did not delete it (deleting data is outside what I do without a separate go-ahead). It is on the Referral Inbox, named AUDIT-TEST.

## Form submission pass 2 (Administrator, synthetic AUDIT-TEST data)

| Form | Result |
|---|---|
| Safety incident (`/safety/incidents/new`) | **BLOCKED by a server 500.** Both POSTs to `/api/v1/safety/incidents` returned 500; API log: `TenantKeyMissing: no tenant key ring for org …` (`34-saas-tenant-platform/seam-registration.ts:276`). The seeded org has no tenant key ring, so the encrypted narrative cannot be stored. No record created (not verified in the DB; table name unknown). |
| Triage intake (`/triage/intake`) | **BLOCKED by a business rule.** `POST /api/v1/triage-calls` returned 409 `TRIGGER_NO_COVERING_SHIFT` (no on-call shift covers the seeded provider entity now). Correct server behaviour; I did not create a shift to get around it. |
| Admission wizard (`/admissions/new`) | **NOT SUBMITTED, deliberately.** Step 1 requires an existing patient and a medical-director ID; an admission cannot be labelled AUDIT-TEST and would write to a seeded patient's record. |

- **F-039 (P2): a missing tenant key ring surfaces as "An unexpected error occurred".** No reason, no correlation ID, no retry guidance; the retry fails identically. The banner is shown above the summary on step 3. Needs an environment fix (seed a key ring) and a more specific user message.
- **F-040 (P2, silent failure): the triage intake failure message is off-screen.** After pressing "Open the call" at the bottom of the long form, the page looked unchanged. The message "The call could not be opened." was at the top of the scrolled container (measured `top = -403` px), and it does not carry the reason (no covering shift) that the API knew. A user at the bottom sees nothing happen.
- **F-041 (P4): completed steps in the safety wizard are struck through** ("~~1. Incident~~" with a green tick), which reads as removed or invalid rather than done. Visual only.
- Observation, not a finding: the safety form's "Occurred at" defaulted to local time correctly (19:24 PDT). Confirms F-038 is specific to the code paths named there.
- The first safety POST appeared to fire on the step 2 to step 3 transition, before I pressed Create draft; I did not establish whether that is intended (draft saved on entering review) or a double-fire. PARTIAL.
- Records created in total this audit: one referral (AUDIT-TEST Synthetic). Nothing else was written.

## Admin app (:5175) pass 2: `:param` routes and interactions (Organization Administrator, `platform_ops`)

Seed limits: real IDs exist only for outbox events, the one tenant (`chartwarden-demo`) and its organization. Plans, subscriptions, refunds, AI capabilities and channels are empty, so those `:param` routes were tested with a nonexistent UUID (not-found handling), not with real records.

| Route (11 `:param`) | ID | Result |
|---|---|---|
| `/admin/ops/outbox/:id` | real | VERIFIED: redirects to the list with a side drawer (`?event=`); shows status, attempts, last error, payload |
| `/admin/ops/outbox/:id` | fake | PARTIAL: list renders, API 404; no not-found message captured |
| `/tenants/:orgSlug` and `/onboarding` | real | VERIFIED: overview and onboarding steps load, 0 errors |
| `/tenants/:orgSlug` | fake | VERIFIED: "Tenant not found." plus a Try again button (404) |
| `/admin/usage/:org` | real | PARTIAL: renders, but `/api/admin/usage/:org/current` returns 404 (no usage row); message shown not captured |
| `/admin/ai-platform/capabilities/:id`, `/admin/plans/:id/edit`, `/admin/subscriptions/:id`, `/admin/refunds/:id/approve` | fake | VERIFIED: page shell plus "unavailable" with Try again (404) |
| `/admin/subscriptions/:id/pause`, `/apply_promo` | fake | **0 API calls**: the form renders for a nonexistent subscription with no existence check; submission NOT TESTED |
| `/admin/messaging/channels/:id/members` | fake | 403 on `/api/v1/messaging/channels/:id/members` for platform ops (not 404); message not captured |
| unknown path | - | VERIFIED: styled "We couldn't find that" page (earlier follow-up item B is fixed in the admin app) |

Interactions:
- **Step-up works and is clear.** Creating a plan returned "This action needs a fresh verification. Re-verify, then try again." with a Re-verify button, leading to `/step-up?returnTo=...` ("Verify with a passkey" / "Use an authenticator code instead"). I cannot supply a second factor, so completing a write is **BLOCKED**; no plan was created.
- **F-042 (P3): disabled submit with no explanation.** New tenant ("Provision tenant"), New plan ("Create draft"), New promo, New refund start disabled; no field is marked required, and entering an invalid slug ("Bad Slug!") and price ("abc") produced no message, only a still-disabled button. A user cannot tell what is wrong.
- **F-043 (P3): typed input is lost across the step-up detour.** After the plan form was refused for step-up, going back showed the panel closed and all four typed values gone. (Web has a ceremony-draft mechanism; the admin app does not preserve this form.)
- **F-044 (P3): not-found states offer "Try again".** Tenant, plan, subscription and refund 404s show a retry button that cannot succeed.
- **F-045 (P3): Key rings screen cannot explain a missing key ring.** Loading `chartwarden-demo` calls `GET /api/v1/platform/tenants/chartwarden-demo/key-ring` which returns 404, shown as "Could not load the key-ring for this tenant." This is the same missing key ring that blocks safety-incident creation (F-039); the console offers no way to see or provision it.
- Positive: outbox payload for `m6.referral.received` carries IDs only (no patient name). VERIFIED for that event type only.
- Environment observation (not a frontend defect): outbox shows 10 failed events in the last 50, e.g. `m2.session.created` with 8 attempts, last error "PseudonymKeyProvider unbound: requires DATABASE_PLATFORM_URL and M35_PSEUDONYM_KEY_KEK to be configured".
- Responsive at 768 (29 routes): no document-level overflow; the nav collapses to a toggle. Tables scroll inside their own container; on `/admin/ops/outbox` the Created column is clipped by about 50 px with no visual cue (P4; screenshot `screenshots/ADMIN-OUTBOX-001-tablet-768-created-column-clipped.jpg`), similar on `/tenants` and `/onboarding/templates`.
- Not tested: New tenant, promo, refund, template and support-session submissions (platform writes behind step-up; the tenant one also provisions an organization and invites an admin by email), tenant lifecycle transitions, kill switches, export requests, feature-flag toggles, the 11 `:param` routes with real subscription/plan/refund records, dark theme, keyboard.
