# WardenLens V3.2 — Browser UX Acceptance Audit

Date: 2026-11-25 · Method: interactive Chrome session against `http://localhost:5173` · No application code or Git history changed; the audit recorded five decisions and started a review in the local dev database (section 3).

> **Status, 2026-11-26.** This is a status note, not a re-run: no scenario was repeated and the findings below are as audited. Changes on branch `feat/wardenlens-unified-review-ux` address D-01, D-02, D-03, D-04 (the field-task panel and the safeguard panel viewer both show the page at a readable size with Fit width / Actual size and a translucent highlight), D-05, D-07, D-09 and D-10; D-06 only in part (the open task's row is marked as current; the category header is unchanged). D-08 (the rejection reason is still optional) and D-11 (no link from the referral to the unified review) are **not** addressed. The scenarios have not been re-run against the rebuilt backend, so the verdict stays **NO-GO**. The screenshots indexed in section 10 are kept locally and are not committed: they total about 19 MB and the PHI scan cannot read images.

## 1. Executive summary

**Recommendation: NO-GO.** Score **50 / 100** on the executed portion. **33 of 48 planned scenarios (69%) were executed**; the other 15 are BLOCKED (7) or NOT EXECUTED (8) and earn no points.

What works: the three-panel workspace, grouped exception categories, in-place Accept / Edit / Reject (each confirmed by the server before the UI shows success), progress and exception counts that update and survive a reload, "Next issue", the source-load / failure / retry path (a failed source cannot be confirmed), and the read-only lock when another reviewer owns the review.

What blocks acceptance:

| # | Defect | Severity |
|---|---|---|
| D-01 | Clicking the "Part 2 / SUD safeguard is unresolved" exception opens an ordinary field task ("ZIP code, page 4"), not the safeguard panel. Reproduced twice. This is the unfixed #1109 finding A. | **P1** |
| D-02 | Identical values are not consolidated. The demographics section is 11,057 px tall with 67 full-size rows (67 "Preview source" + 67 "Review decision" buttons, no expand control). This is the original complaint. | **P2** (headline criterion fails) |
| D-03 | A patient-identity exception opens a combined panel at its top; the selected page's controls are ~1,600 px below the fold, with no selected marker. | P2 |
| D-04 | The source highlight is a solid bar that hides the text it points at (a 137×4 px box with a 2 px border on a 321×416 px render of a 1224 px image). | P2 |

Not verified, so no assurance given: the referral round-trip (WL-06), roles without clinical licence or Part 2 eligibility (WL-08), restricted-source rendering, refresh-failure reconciliation and transport failure (WL-07 B/D), and browser zoom. No P0 was observed in what was executed.

## 2. Tested commit and environment

| Item | Value |
|---|---|
| Commit | `f93908219d4c594a52684da1d43bb4a9812cb4d3`, branch `feat/wardenlens-superadmin-support-session`, clean tree |
| Frontend | Vite dev server (pid 38253, started 2026-11-22 13:09) on `localhost:5173`. The served `review-exception-tasks.ts` matched the file on disk, so the frontend is HEAD. |
| Backend | Docker `chartwarden-api-1`, image created **2026-11-22 23:36 PST**, `/version` reported `gitSha: "unknown"`. The container had been started from the worktree `.claude/worktrees/doclens-intake-accuracy` (branch `fix/doclens-intake-accuracy` @ `ddea0c16b`), which is 50 commits behind and 8 ahead of the tested commit. The review-workspace route, lifecycle, audit and support-access changes of 11-23 to 11-25 were therefore not in the backend I tested; backend-dependent results describe that branch, not HEAD. **Update (after the audit):** the stack was rebuilt from this checkout; `/version` now reports `f93908219…` and migration 1555 is applied. The audit scenarios were not re-run against the rebuilt backend. |
| Services | `/health` 200; `/ready`: db, valkey, minio, outbox ok, `m22DocumentUpload` ready; worker `:3001` 200; Docling `:8000/health` 200. Governed-AI availability is not reported by `/ready`; extraction already existed, so no new extraction was run. |
| Account | Seeded RN reviewer `casey@chartwarden.local` (role `rn`, clinical category, holds `intake.review`), org `chartwarden-demo`. Credentials came from the seed's gitignored local file; none are recorded here. |
| Viewport | Start 1712×831 CSS px at 2× DPR (screenshots are 1568×761). |

Limitations: the Chrome tool saves JPEG; every file was converted to PNG with `sips`. The responsive shots were captured at 0.6–0.7 scale. Console tracking only began late in the session (one check at the end: no errors); network statuses were read for the decision and workspace calls only.

## 3. Synthetic test data

Batch `4389ead9…` (uploaded 11/22 10:08 PM, fax): **19 source documents, 217 observations**, patient "Arthur Doclens", from the project fixture `apps/backend/__tests__/fixtures/doclens-complex-packet/`. Hospital and clinician names are invented (Riverside General Hospital, Priya Raman MD). The packet shows "Unassigned" patient and an unresolved SUD flag. Nine other synthetic batches exist (87–226 fields) and one 11-field batch ("Doclens, Mae").

**State left behind (local dev DB):** Casey started the review on `4389ead9…` and it is still "In review" under Casey. Five decisions were recorded through the UI: City page 2 accepted; City page 3 corrected "Salem" → "Keizer"; City page 13 rejected ("Synthetic audit rejection test"); City page 17 accepted; Allergy 1 "Lisinopril (angioedema)" accepted. Use "Release review" to undo ownership; I found no UI undo for individual decisions.

Test-only instrumentation: in-page JavaScript shims (image `src` rewrite for page 17; a `window.fetch` wrapper that proved ineffective). Both were discarded by page reloads. No app code was changed.

## 4. Acceptance matrix

| Test | Scenario | Result | Evidence |
|---|---|---|---|
| WL-01 | Identical values shown once by default | **FAIL** | 03, 04 |
| WL-01 | Every underlying candidate stays accessible | PASS | 05 |
| WL-01 | Conflicting values distinguishable | PASS | 06 |
| WL-01 | Edited value shown beside the original, survives reload | PASS | 07 |
| WL-02 | Categories group exceptions | PASS | 08 |
| WL-02 | Demographic conflict opens the right task | PASS | 09 |
| WL-02 | High-risk item opens the right observation | PASS (with D-05) | 10 |
| WL-02 | Patient-identity exception opens its task in view | **FAIL** | 11 |
| WL-02 | SUD exception opens the safeguard panel | **FAIL** | 12 |
| WL-03 | Preview loads with feedback, correct page, no stale image | PASS | 13, 13a, 15 |
| WL-03 | Selected evidence highlighted | **FAIL** (D-04) | 14 |
| WL-03 | Restricted source explained without content | NOT EXECUTED | no second account used |
| WL-03 | Render failure shows error; cannot be confirmed | PASS | 17, 17b |
| WL-03 | Retry recovers | PASS | 18 |
| WL-04 | Accept (source-confirmed, server 201) | PASS | 19, 20, 21 |
| WL-04 | Edit (value + original shown) | PASS | 22, 23 |
| WL-04 | Reject (recorded) | PASS (reason optional, D-08) | 24, 25 |
| WL-04 | Stays in workspace; no silent group decisions | PASS | 26 |
| WL-04 | No success shown before server confirms | PASS | 21 |
| WL-05 | Decision count updates (0→3→4→5 of 217) | PASS | 27, 28 |
| WL-05 | Exception counts update (135/124→134/123; high-risk 98→97) | PASS | 28b |
| WL-05 | Next Issue selects an eligible task | PASS | 29 |
| WL-05 | Persists after reload | PASS | 30 |
| WL-06 | Originating referral reachable | PASS | 31 |
| WL-06 | Records/WardenLens entry from the referral | **FAIL** (D-11) | 32 |
| WL-06 | Review ready, completion, writeback, return (4 scenarios) | BLOCKED | see section 5 |
| WL-07 A | SUD task routing | **FAIL** | 12 |
| WL-07 B | Reconciliation after refresh failure | BLOCKED | injection not possible |
| WL-07 C | Intermediate widths | PASS | 40 |
| WL-07 D | Network transport failure | NOT EXECUTED | see section 9 |
| WL-08 | Review owned by another user is read-only | PASS | 43 |
| WL-08 | High-risk licensing, wrong-patient exclusion, Part 2 view (3 scenarios) | NOT EXECUTED | no second account used |
| WL-08 | Privileged support read-only view | BLOCKED | no support session; backend image predates #1112 |
| WL-09 | 1920, 1440, 1280, 1024, 768 wide (5 scenarios) | PASS (no horizontal overflow) | 48–52 |
| WL-09 | 375 wide | BLOCKED | window cannot go below ~500 px |
| WL-09 | Zoom 125 / 150 / 200% (3 scenarios) | NOT EXECUTED | tool rejects zoom shortcuts |
| WL-10 | Usability review | executed (qualitative), see section 8 | 57, 59 |

Tally over 48 scenarios: PASS 26 · FAIL 6 · qualitative review 1 · BLOCKED 7 · NOT EXECUTED 8.

## 5. Confirmed functional defects

**D-01 · P1 · SUD exception opens the wrong panel (WL-02, WL-07 A).**
Steps: open batch → expand "Part 2 / SUD safeguards" → click "Part 2 / SUD safeguard is unresolved". Expected: the Part 2 / SUD safeguard panel (Confirm / Reject false positive). Actual: center panel shows "Review task · Page 4 / ZIP code / 97301", an ordinary field decision. Reproduced twice, the second time from a reset state. Likely cause (code read, not a browser result): `review-exception-tasks.ts` copies `candidateId` from the first reason, and the SUD exception carries the page-4 ZIP candidate. The safeguard is still reachable through the "Documents & safeguards" card, so the server completion gate is not bypassed, but the exception that names the blocker leads somewhere else. Evidence: `12-sud-safeguard-task.png`.

**D-02 · P2 · No consolidation of identical values (WL-01).** City shows six full "Salem" rows; State eight; legal first and last name twelve each. Expected one value with N source references. Evidence: 03, 04, 05. Distinct conflicts stay visible (street address: "1220 Alder St" ×2, "1400 Harbor Blvd" ×2, "1400 Harbor Blwvd" ×2, badge "3 conflicting values"), so nothing clinically significant is hidden; the failure is the repetition.

**D-03 · P2 · Identity task is off screen (WL-02).** Click "Patient identity needs review on page 13". The source for page 13 loads, but the task column stays at scrollTop 0 on a combined "Documents & protected information" panel whose first block is the Part 2/SUD safeguard (page 4). The page-13 identity block is at y 1628 of an 831 px viewport and carries no selected attribute. Evidence: 11.

**D-04 · P2 · Highlight hides the evidence (WL-03).** The overlay `wx-unified-source-box` measured 137×4 px with a 2 px solid border, so it renders as an opaque bar over the line (the zoomed capture shows line "3." fully covered). The page image is 1224 px wide but displayed at 321×416 px at every window width from 768 to 1920. Evidence: 14, 13. I did not open "Advanced tools", so a zoom control may exist behind it.

**D-05 · P2 · Identically titled high-risk rows (WL-02).** The category lists 98 rows titled "Diagnosis needs high-risk review" or "Allergy needs high-risk review" with the same one-line reason and no value, so a coordinator cannot tell them apart without opening each. Evidence: 28b shows three same-titled "Allergy needs high-risk review" rows; 10 shows the selected observation.

**D-06 · P3.** Clicking a category title does nothing; only the small chevron expands it. No selected-state styling on the clicked exception row.
**D-07 · P3.** After a save, Accept/Edit/Reject stay enabled with the comparison box still ticked, and the task header still shows the pre-edit value ("Salem" after correcting to "Keizer"). Evidence: 23, 25.
**D-08 · P3.** Rejection reason is optional ("at least 5 characters if entered"); the audit brief expected it to be required. Product decision needed. Evidence: 24.
**D-09 · P3.** Read-only panel still says "A decision is sent only after … the comparison checkbox is selected" although no checkbox renders. Evidence: 43.
**D-10 · P3.** Page load auto-opens the first task ("Date of birth") instead of restoring the reviewer's last task.
**D-11 · P3.** The referral workspace step 1 offers "Add records" and the sidebar "Intake review" (the standalone queue); I found no link to the batch's unified review. At an 831 px viewport height the step content is clipped to about 60 px above the sticky action bar. Evidence: 31, 32. Observed on one referral only.

Why WL-06 completion is BLOCKED: all six referrals have an unresolved patient match and map to 200+ field batches with an unresolved SUD flag; the only small batch (11 fields) has no referral and is owned by another reviewer. Completing any of them needs hundreds of clinical decisions, and creating a new small referral needs a new AI extraction run, which I did not start.

## 6. UX and visual-design findings

- Page length: the demographics detail starts after six large section cards and runs 11,057 px (D-02).
- Wording: "Review decision →", "Preview source", "Source loaded" and "Server safeguards and completion rules remain authoritative" are clear. "Opening this preview does not confirm the source…" appears on every task.
- Counts are understandable ("135 underlying requirements consolidated into 124 tasks"). When a source fails to load, a "1 blocked" item appears and clears after Retry; correct, but surprising.
- The center column mixes single-field tasks with a long combined safeguards panel (about 2,600 px high).

## 7. Clinical safety and authorization findings

- Source confirmation is guarded: Accept, Edit and Reject are disabled until the page image has loaded and the comparison box is ticked; with a failed image the box itself cannot be ticked (`17b`). PASS.
- Every decision was a `POST /api/v1/intake/reviews/{id}/decisions` → **201**, followed by `GET …/uploads/{id}/workspace` → 200; the UI showed "Decision saved" only afterwards. Page images returned 200.
- A batch owned by another reviewer renders no decision controls and says so (`43`). PASS.
- D-01 weakens the Part 2 workflow's guidance but not its server gate.
- **Not verified:** high-risk reviewer licensing, wrong-patient exclusion, Part 2 restricted views, tenant isolation, privileged support read-only access. Casey is an RN, so every high-risk item was available to them; that proves nothing about unlicensed users. No clinical-safety verdict can be given for these.
- The backend is older than HEAD (section 2), so authorization behaviour added after 2026-11-22 23:36 PST was not exercised.

## 8. Accessibility, responsive and usability findings

- No horizontal overflow at 1920, 1440, 1280, 1024, 768 or the smallest reachable width (500). Requested vs actual viewport: 1280×720→1280×543; 1024×768→1024×591; 375×812→500×635 (window minimum).
- At ~500 px the panels stack; tapping "Review decision" scrolled the task panel into view. Good.
- Contrast: "In review" pill 3.21:1; "N items to review" pill 2.95:1 (below 4.5:1 for small text).
- Touch targets: 199 visible controls are under 44 px in one dimension; 4 are under 24 px (measured at 500 px).
- Focus: a 3 px solid dark outline is visible on keyboard focus (`56a`). Full keyboard order, modal and drawer focus were not audited.
- The source viewer does not grow with the panel (D-04).

**WL-10 usability notes** (new-coordinator view): the next action is obvious after "Start review"; repeated rows are overwhelming (D-02); exception counts are understandable; source evidence is one click away; three panels are comfortable at 1440+ but tight at 1024; mobile is workable for reading, not for dense review. Representative effort: deciding one field from the list takes 3 clicks (Review decision, comparison checkbox, Accept) with no page transition, plus scrolling to reach the group; reaching one identity decision from the exception list takes 2 clicks plus ~1,600 px of scrolling (D-03). Most confusing interaction: the SUD exception (`12`).

## 9. Console and network

- Console: one check at the end of the session, no errors. Earlier pages were not tracked.
- Network: decisions 201 ×5, workspace reads 200, page images 200; no 4xx/5xx except the deliberately injected page-17 image failure (a 404 to a nonexistent path).
- `window.fetch` shimming did not affect the app's API client, so refresh-failure (WL-07 B) injection was not possible from the page. Chrome DevTools offline emulation might serve WL-07 D; I did not attempt it.

## 10. Screenshot index

The files were saved in `screenshots/` of the auditor's checkout (PNG converted from the tool's JPEG); they are not committed (see the status note at the top).
`00-application-home` (signed-in home), `00a-login-unauthenticated`, `01-intake-review-queue`, `01a-intake-referrals-list`, `02-unified-workspace-initial`, `03`–`07` (WL-01), `08`–`12` (WL-02), `13`, `13a`, `14`, `15`, `17`, `17b`, `18` (WL-03), `19`–`26` (WL-04), `27`–`30`, `28b` (WL-05), `31`, `32` (WL-06), `40-intermediate-width-layout`, `43-review-owned-by-another-user`, `48`–`52`, `53-mobile-500-smallest-reachable`, `56a-keyboard-focus-visible`, `57-overall-workspace`, `59-final-review-state`.
**Not captured (scenario not executed or blocked):** 16, 33–39, 41, 42, 44–47, 54–56, 58 (the most confusing interaction is `12-sud-safeguard-task.png`).

## 11. Recommended corrections (not applied)

1. D-01: route a SUD exception to the safeguard task by kind, before any `candidateId` match; add a browser regression for it.
2. D-02: collapse identical normalized values into one row with an "N sources" disclosure; keep distinct and edited values separate.
3. D-03: scroll the task column to, and mark, the selected identity block; or give each identity task its own panel.
4. D-04: render the page at a readable size with zoom; make the highlight a translucent fill without a border that exceeds the box height.
5. D-05: put the value and section in high-risk row titles.
6. Rebuild the Docker API from HEAD before the next acceptance run (done after this audit), then execute the blocked and unexecuted scenarios (second account, support session, zoom, failure injection, a small referral-linked packet).
7. D-06 to D-11 as listed; decide D-08 with product.

## 12. Usability score (executed portion only)

| Area | Max | Awarded | Basis |
|---|---|---|---|
| Information consolidation | 20 | 6 | exception consolidation, conflicts and edits shown; field repetition fails |
| Navigation and exception handling | 20 | 8 | grouping and two of four task types work; identity and SUD fail |
| Source evidence usability | 15 | 8 | load, failure and retry good; highlight and size poor; restricted case unexecuted |
| Inline clinical decisions | 20 | 14 | accept, edit, reject, ownership lock work; reconciliation and transport unexecuted |
| Progress and workflow continuity | 15 | 9 | progress, persistence, next issue work; referral return unverified |
| Responsive design and accessibility | 10 | 5 | no overflow, focus visible; contrast, targets, zoom, 375 px |
| **Total** | **100** | **50** | |

## 13. Final recommendation

**NO-GO.** D-01 is a P1 on the Part 2 workflow, D-02 fails the redesign's headline requirement, and the clinical-safety, authorization, referral-return and failure-recovery scenarios are unverified. The score does not offset those. Re-run after fixing D-01 to D-04 and rebuilding the backend image.
