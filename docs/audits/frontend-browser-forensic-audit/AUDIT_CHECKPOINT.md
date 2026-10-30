# AUDIT CHECKPOINT

Updated: 2026-10-22 (session 1)

## Environment
- Web `http://localhost:5173` (Vite dev, `apps/web`); admin dev server `http://localhost:5175` (`apps/admin`); portal dev server not running (needs start); API in Docker on `:3000`.
- Browser: Claude in Chrome, tab group 1307407580. Session already signed in as the seeded Administrator (org "Engrace Hospice"). Other seeded roles: Clinician, Compliance Auditor, Organization Administrator (credentials in gitignored `CREDENTIALS.local.md`; never copied here).
- Data: local seeded synthetic data only. Never run live suites or destructive flows here.

## Done
- Recon: project docs, design authority (see 02), route inventory `inventories/routes.csv` (356 descriptors: web 299, admin 39, portal 18; 182 static non-auth web paths).
- Design-authority conflicts DA-1, DA-2 recorded (02).
- Web static-route baseline sweep run 1 (178 routes; second half unreliable, session expired ~route 100). Results were kept only in browser `sessionStorage` (`__sweep`), NOT yet exported to `inventories/`.
- Fresh-session recheck of 20 flagged routes; findings F-001, F-002 and open items DA-1, DA-2, U-1 in `00-executive-summary.md`.
- Re-signed in with the seeded Administrator (local test account) after expiry. Last browser action: Resource-Timing recheck ending on `/subscription`.
- Web sweep run 2 (second half, 68 routes from `/billing/noe` to `/mdm`): completed on ONE session, no expiry, no redirects, no horizontal overflow, API errors captured (see F-003, F-004, NF-1). Raw rows live only in `sessionStorage.__sweep2` and are not exported. First-half routes (`/admin/staff` … `/billing/dde`, ~110 routes) were swept in run 1 with a valid session; their per-route API statuses were NOT captured, so redo them with Resource Timing.
- Web static sweep now complete with API capture: first half (sweeps 3 and 4: 61 routes, `/admin/staff` to `/me/evv/devices`) and second half (sweep 2: 68 routes). Third chunk (sweep 5: 38 routes, `/triage` to `/billing/dde`) also done: no API errors, redirects, missing h1 or overflow. **Static web sweep with API capture is complete for all 167 non-auth static routes** (auth routes `/login*`, `/forgot` etc. deliberately skipped; `/step-up`, `/auditor/*`, `/security/passkeys` not swept). This is a load-state check only (page renders, API 2xx), NOT interaction, state or fidelity coverage. Next: dynamic `/patients/:id/*` routes. Raw rows only in `sessionStorage` (`__sweep2`, `__sweep4`).
- Pencil MCP works against the pen.dev app (`--app desktop`, config edited in `~/.claude.json`, backup beside it). `.pen` corpus = old Lantern design (see 02). Pencil exports in `evidence/pencil-lantern-ref/`.
- Patient chart deep dive (synthetic patient Rosa Delgado, Administrator role): 12 chart tabs load; Clinical tab 404s analysed (F-009 P1 mechanism); Medications tab verified clean-empty; New medication page tested (F-011, F-012); 12 patient-scoped pages checked for patient identity; tab strip root cause (F-008b). All 12 chart tabs have now been viewed visually as Administrator (screenshots filed; findings F-015 to F-019, NF-3 to NF-5). Not yet done: tab interactions (sub-tabs inside Plan of Care, Orders, Claims; row actions; Upload), Clinician and Compliance Auditor passes (needed to prove or disprove the F-009 harm); a second patient (Okonkwo, Active); chart at 1280/1920.
- Evidence screenshots now in `screenshots/` (7 files, audit ID scheme).
- U-1 RESOLVED: screen-lock Unlock mints an org-less session (F-031, reproduced). See 00-executive-summary.
- DA-1 resolved by the user: `#1a56eb` authoritative.
- Tooling lessons: the app's fetch is captured before page hooks, so use `performance.getEntriesByType('resource')[].responseStatus`; sweeps must run in chunks of ~60 routes, re-checking the session between chunks.

- Clinician pass done: 12-point checks plus a 178-route sweep (see S-1..S-6 in 00). S-5 routes visually checked (F-022..F-024 added). Follow-ups: classify S-6 404s, `/supplies/par-stock` render.

- Compliance Auditor and Org Admin passes done (178 routes each, buffer-corrected; see 00). New: F-025..F-029, A-1..A-4, O-1..O-3, a fourth U-1 data point (new session row seconds after the old one's last activity). Tooling lesson: `performance.clearResourceTimings()` per route and filter `/api/v1`; the Vite dev pages overflow the 250-entry buffer. Admin/Clinician 4xx capture is unconfirmed for that reason.

## Remaining
- Admin app sweep (`:5175`), portal sweep (start portal dev server first).
- Dynamic routes (`/patients/:id/...`) with a seeded patient.
- Screenshots + interaction tests per module batch, forms, states, responsive, a11y, security, perf.
- Role passes: Clinician, Compliance Auditor, Org Admin.
- Previous-audit regression retest (2026-08-07 reports).
- Pencil frame comparison — blocked on DA-1/DA-2.

## Blockers
- Mockup PNGs missing from the repo (DA-2).
- Sweep tooling limits: synthetic pushState navigation, so full-page deep-link/refresh behaviour needs separate checks.

## Next action
Administrator and Clinician sweeps re-run with the corrected method (done: Clinician identical, Administrator confirms F-002..F-005, new candidate F-030, fifth U-1 ending). Next: safe test of the auditor create-forms (F-025); controlled U-1 repro; then admin app (:5175) and portal.

- F-025 probe done (3 of 7 endpoints; server returns 403; downgrade to P3 UX). Next: admin app :5175, then portal.

- Admin app :5175 swept (28 static routes clean; params, interactions NOT TESTED). Portal dev server started on :5174/portal/ (background). Next: portal sweep.

- Portal signed-out pass done (F-032, F-033); signed-in portal BLOCKED (no seeded account). Staff session signed out in the browser.
- Remaining: dynamic :param routes, chart tab interactions, forms/dialogs, responsive, a11y, security, perf, previous-audit regression, S-6 404 classification, export sweep rows, coverage ledger, remediation backlog, scorecard.

- Later pass done: chart/responsive/a11y/security/S-6 + raw sweep export + files 03-06 written (scorecard NOT ISSUED). Still NOT TESTED: form submissions, dark theme, keyboard a11y, perf, phone <500px, non-chart :param routes, signed-in portal.

- Form submission pass done: one synthetic referral created (AUDIT-TEST, still in local DB), F-038 found.

- Form pass 2 done: safety 500 (TenantKeyMissing), triage 409 (no covering shift), admission not submitted. F-039..F-041.

- Admin app pass 2 done (F-042..F-045); writes BLOCKED by step-up (no second factor). Window left at 768x1024; restore.

- Backlog filed as GitHub issues #589-#600.
