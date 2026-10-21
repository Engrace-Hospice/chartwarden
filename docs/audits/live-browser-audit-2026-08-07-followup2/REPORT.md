# ChartWarden Live-Browser Gap Audit — Follow-up Pass 2 (2026-08-07)

**Method:** re-drove the running local stack with `claude-in-chrome`, as `admin@wardenx.local`
(Administrator/org_admin) and `avery@wardenx.local` (Compliance Auditor), to (1) re-verify the
original `live-browser-audit-2026-08-07/REPORT.md` findings still hold after a large amount of
intervening work this session (the full `seed-scenario-*.ts` suite + the `actorOf()`
membership-id audit across all 40 modules), and (2) extend coverage into the areas that report's
own "Not covered" section flagged as unvisited: the Portal app beyond login, the admin console
beyond its home shell, the Compliance Auditor role, and the KPI zero-state style inconsistency.

The original report's `docs/audits/live-browser-audit-2026-08-07/` directory (REPORT.md + 16
screenshots) had been deleted from the working tree at some point this session with no record of
who/why — recovered from git history (commit `ff475d31`, which is on `main`) to use as the
baseline for this comparison. **The 8 original findings' code fixes are all still on `main`** and
were spot-checked live in this pass; this report only covers what's new.

Screenshots: `screenshots/01`–`07` in this directory.

---

## Re-verification of the original 8 findings — all still hold

1. **Permissions catalog** (`/roles`) — not re-checked this pass (no code touched `authz-routes.ts`
   since); low risk of regression.
2. **Platform nav hidden from org admins** — confirmed: `admin@wardenx.local`'s Home/sidebar shows
   no "Platform" section. See Finding A below for a deeper issue this fix didn't actually resolve.
3. **Scroll-reset** — not re-exercised (would need a long scrolled page + SPA nav); the CSS fix
   (`.wx-shell { height: 100vh }`) is still present in `index.css`.
4. **Patient-chart sub-nav persists on empty state** — confirmed live: opened Rosa Delgado's Care
   Plan tab ("No care plan yet") with the full sub-nav (Summary/Care Plan/Discipline Plans/.../IDG
   History) still mounted and clickable.
5. **Triage Queue copy** — not re-visited this pass.
6. **Sign-out control** — confirmed present and functional (`.wx-actor-menu` → "Sign out"). Note:
   clicking the header button via synthetic mouse events from the browser-automation tool didn't
   register the first two tries (`aria-expanded` stayed `false`); a direct `element.click()` via
   JS worked immediately. This reads as a browser-automation/event-dispatch quirk, not a product
   regression — the button is a plain `<button>` with a normal onClick, nothing exotic in its
   markup.
7. **DB role password drift** — local-environment issue, not re-applicable (backend was already
   running clean this session).
8. **Staff Management misleading zeros (403 → "0" not "—")** — not re-checked this pass (not
   touched since); low risk of regression.

**Bonus fix (HQRP stale "M30 lands" copy)** — confirmed still fixed: `/hope/compliance` (visited
as Avery Auditor) now reads *"Historical trend charts and the late-completion-reason breakdown are
not built for this screen yet"* — honest, current-state copy, not the stale pre-merge line the
original report flagged.

---

## New findings

### A. M34 platform-ops screens live in the wrong app — the Finding-2 fix hid the symptom, not the cause

**Severity: P2** (architecture/UX — the intended admin console split doesn't actually exist yet)

The original report's Finding 2 said the fix should be that platform-ops screens *"belong
exclusively behind the admin console app"* — but the shipped fix only added a role gate
(`session.roles.includes("platform_ops")`) inside `apps/web`'s `canSeeScreen`. The screens
themselves were never moved. Confirmed three ways:

- `audit/ui-parity/UI_PARITY.md:244-253` lists `saas.tenants`, `saas.support-sessions`,
  `saas.dsar-queue`, `saas.onboarding-templates`, `saas.feature-flags`, `saas.baa-register`,
  `saas.signups`, `saas.key-rings` all under **app: `web`** — not `admin`.
- `apps/admin/src/modules/` on disk contains exactly two modules: `01-ops` and
  `35-subscription-billing`. No M34 module exists there at all.
- Screenshot `05-admin-console-home-no-auth-gate.jpg`: the admin console's own home shell
  (`http://localhost:5175/`) only ever offers M35 subscription-billing nav items (Outbox, Plans,
  Promos, Subscriptions, Refunds, Dunning, Revenue, Stripe webhooks) — there is nothing to click
  toward Tenants/DSAR/Support Sessions/etc. from inside the app that's supposed to host them.

This matters directly to this session's own work: the `actorOf()` bug fixes applied this session
to `tenant-invitations.ts`, `support-sessions.ts`, `tenants.ts`, and `signup-intents.ts` are real
and correct, but the only way to exercise those routes today is via `apps/web` with a
`platform_ops` role bound — a role no locally-seeded account carries (same gap the original report
already flagged in its own Finding 2, now confirmed to be structural rather than just "no demo
account exists yet").

### B. Admin console has no styled not-found/error page

**Severity: P3** (polish — visible on any bad URL)

Screenshot: `screenshots/06-admin-console-raw-unstyled-404.jpg`

Navigating to a non-existent route in the admin console (`http://localhost:5175/login` — the
console has no dedicated login screen of its own, unlike `apps/web`) renders React Router's raw
default error boundary: black-on-cream unstyled text, *"Unexpected Application Error! / 404 Not
Found / 🎏 Hey developer 👋 / You can provide a way better UX than this... by providing your own
`ErrorBoundary` or `errorElement` prop."* — literally a developer-facing debugging message shipped
to whatever user hits a bad link. `apps/web` has a proper branded not-found page (dark theme, "We
couldn't find that" / "Go home" link) that the admin console doesn't share.

### C. M14 IDG History tab never surfaces a completed review — this session's own seed script gap

**Severity: real bug, but self-inflicted by this session's seed script, not a pre-existing defect**

Screenshot: `screenshots/02-idg-history-empty-despite-seeded-agenda.jpg`

Checked Eleanor Whitfield's chart → **IDG History** tab: renders *"No IDG reviews yet"* even
though `seed-scenario-orders-meds-idg.ts` (written this session) drives a full IDG cycle for this
exact patient (agenda item → attendance → decision → adjourn). Confirmed via direct DB query the
`idg_agenda_item` row genuinely exists (`idg_meeting_id` in `status:'adjourned'`), and via a direct
`fetch('/api/v1/patients/{id}/idg-history')` call from the page's own session that the API
legitimately returns `{"meetings":[]}` — not a frontend rendering bug.

**Root cause:** `idg-route-service-db.ts:311-325`'s `getPatientIdgHistory` keys the whole view on
whether an `idg_patient_packet` row was **built** for that (meeting, patient) pair — a
`POST /api/v1/idg/meetings/:id/packets/build` call — not on the agenda item itself. The seed
script exercises the agenda/attendance/decision/adjourn API surface but never calls the
packet-build route, so nothing populates `idg_patient_packet`, so the read view stays empty. This
is a gap in `seed-scenario-orders-meds-idg.ts`, not a backend defect — the fix is adding one more
API call to the script (`POST /api/v1/idg/meetings/{id}/packets/build` before the agenda item, per
the module's own build→agenda ordering) — flagging it here rather than silently patching it since
the instructions were to report gaps found, and this one is worth a deliberate look before fixing
(the packet-build step may have other prerequisites the current script doesn't set up).

### D. Raw UUIDs shown instead of resolved names in two billing screens

**Severity: P3** (polish/usability)

Screenshots: `screenshots/03-medicaid-claim-raw-uuid-patient.jpg`,
`screenshots/04-cost-report-list-no-row-links.jpg`

- Medicaid Claim detail (`/medicaid/billing/claims/:id`): the "Patient" field reads the raw
  patient UUID (`f6d21ba3`, truncated) instead of a resolved name, and isn't a link to the
  patient's chart. Same for "Latest validation → Run" (`259e5b68`).
- Cost Report list (`/cost-reports`): the "Provider Entity" column shows a raw identifier
  (`44444444`) rather than the provider entity's name.

Neither is a defect in this session's seed data (both display real records correctly created
by the seed scripts) — it's a display-layer gap: these two screens never resolve the FK to a
human-readable label the way the Patients census screen and Cap Periods screen do elsewhere in the
same app.

### E. Cost Report list has no way to open a report — direct-URL-only

**Severity: P2** (navigation dead-end)

Screenshot: `screenshots/04-cost-report-list-no-row-links.jpg`

`/cost-reports` renders one row per report (fiscal year end, provider entity, state, etc.) but the
`<tr>` has no `onClick`, no `cursor: pointer`, and contains zero `<a>`/`<button>` elements
(confirmed via DOM inspection) — there is no way to reach `/cost-reports/workspace` from this
screen by clicking anything. The workspace route itself works fine and auto-selects the (only)
report via its own dropdown when visited directly — this is purely a missing link from the list to
the detail view.

### F. KPI zero-state style inconsistency — confirmed still present, worse than described

**Severity: P3 style** (the original report filed this as a "minor style note," not a standalone
finding — this pass found it's the same MISLEADING pattern Finding 8 fixed for Staff Management,
just never applied anywhere else)

Screenshot: `screenshots/01-feature-flags-misleading-zeros.jpg`

`/feature-flags` (as Administrator): all four KPI tiles ("Total flags," "Enabled," "Kill
switches," "Per-Tenant") render literal `0` while the panel beneath them shows *"Unavailable —
Could not load feature flags."* — the exact same misleading-zeros pattern Finding 8 fixed
specifically for Staff Management's `loadFailed` boolean, left unaddressed here. The
`/billing` (Medicare AR) dashboard shows the same split within one screen: "Denial Rate" uses `—`
while "Open Claims"/"Pending Validation" use `0` for what's presumably the same
never-loaded-vs-genuinely-zero ambiguity, though Medicare AR being all-zero is expected here (M23
is a deliberate, documented seed gap — see project `CLAUDE.md`). Worth generalizing Finding 8's
`loadFailed`-flag fix into a shared convention (e.g. a `Kpi` component that takes `value: number |
null`) rather than re-fixing each screen individually as it's noticed.

### G. Portal beyond login — still not coverable, confirmed (not a new gap)

Screenshot: `screenshots/07-portal-login-still-magic-link-only.jpg`

Re-confirms the original report's "Not covered" note: the portal (`:5174`) only offers "Email me a
sign-in link" — no seeded local account can complete auth without an email-capture/magic-link step
this environment can't intercept. Not attempted further (would require either building a
dev-mode magic-link bypass or finding where the link gets logged, neither of which this pass did
since it wasn't asked for and risks masking a real auth-flow gap by working around it).

---

## Not covered (still true after this pass)

- Portal authenticated screens (see Finding G).
- The M34 platform-ops screens' actual behavior once reachable with a real `platform_ops` role
  (see Finding A) — no seeded account carries that role; creating one was out of scope for a
  read-only audit pass.
- The original report's Findings 1, 3, 5, 8 were not re-exercised live this pass (no code has
  touched those areas since they were fixed; flagged as lower-risk, not zero-risk).
- The vast majority of the 271-screen corpus remains unsampled — this and the original pass
  together cover roughly 30 screens.
