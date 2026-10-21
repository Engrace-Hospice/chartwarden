# ChartWarden Live-Browser Gap Audit — 2026-08-07

**Method:** started the full local stack (Postgres, Valkey, backend `:3000`, and all three
Vite SPAs — web `:5173`, portal `:5174`, admin console `:5175`), then drove the running app
with `claude-in-chrome` as the seeded `admin@wardenx.local` (Administrator, org-scoped) user,
navigating the dashboard, admin, clinical, revenue, scheduling, on-call, IPU, quality, and
platform surfaces. Findings below are things actually observed live, not derived from reading
source in isolation — every finding was reproduced in the browser first, then traced to a
`file:line` in the codebase for evidence.

**Scope note — sampling, not exhaustive:** the app registers 271 screens across 3 SPAs (per
`audit/ui-parity/`). This pass sampled roughly 25 screens chosen for breadth across module
areas plus the two extra apps' home/login screens; it is not a screen-by-screen sweep of the
full corpus. Treat "no gaps found" on an unvisited screen as **not evaluated**, not "clean."

**Servers started this session** (none were previously running for backend/portal):
- `wardenx-postgres` / `wardenx-valkey` Docker containers — already running.
- Backend `:3000` — was running but non-functional (`wardenx_app` DB password had drifted
  from `.env`); fixed with `ALTER ROLE wardenx_app LOGIN PASSWORD 'wardenx_app'` (see
  Finding 6) and restarted.
- Web `:5173` and admin console `:5175` — already running from a prior session.
- Portal `:5174` — not running; started fresh (`cd apps/portal && bun run dev`).

---

## Follow-up verification pass — 2026-08-07 (same day)

Re-ran the live-browser audit after finding that Findings 1–6 below had all been remediated in
the working tree (`git status` showed 12 modified files, each with comments explicitly citing
"live-browser audit #N"). Restarted the backend (picked up a stale `wardenx_app` password drift
again — same class of issue as the original Finding 7, fixed the same way) and re-verified each
fix live, then spent the remaining pass logged in as the **Clinician** role (`casey@wardenx.local`,
not covered in the original pass) looking for anything new.

**Verified fixed, holds up live:**
- **Finding 1** (permissions catalog) — `/roles` now reads "Administrator — 816 of 817
  permissions" with the full catalog rendering (org.manage, mdm.*, consent.*, tenant_export.*,
  fhir.*, ai.*, etc.). Screenshot: `screenshots/09-signout-menu-verified.jpg` (permissions list
  visible in background). One loose end: the catalog now reports **817**, one more than the
  816 rows actually in the local `permission` table checked in the original pass — not
  investigated further, likely benign (a catalog entry not yet backfilled to this dev DB), but
  worth a quick look if it recurs.
- **Finding 2** (Platform nav exposed to org admins) — the entire "Platform" nav section (Cap
  Constants, Feature Flags, Tenants, DSAR Exports, etc.) is now absent from the Administrator's
  Home dashboard and sidebar. Confirmed via `apps/web/src/shell/actor-session.ts` — `canSeeScreen`
  now additionally gates any `navGroup: "Platform"` screen on `session.roles.includes("platform_ops")`,
  with 3 new unit tests covering the hide/show/RBAC-without-role cases.
- **Finding 4** (patient-chart sub-nav vanishing) — Care Plan's "No care plan yet" empty state
  now renders inside the full patient banner + module rail (Summary/Care Plan/Discipline
  Plans/Encounters/.../IDG History all present and clickable). Screenshot:
  `screenshots/11-care-plan-subnav-fixed.jpg`. Fixed via a new shared `PatientChartBail`
  component (`apps/web/src/shell/chart-module-rail.tsx`) applied consistently across all 5
  originally-flagged files.
- **Finding 5** (leaked spec commentary in Triage Queue) — all three instances rewritten into
  plain operational language; the rationale moved into code comments instead of user-facing
  `<Card>`s. Screenshot: `screenshots/12-triage-copy-fixed.jpg`.
- **Finding 6** (no sign-out control) — the header user-name is now a real button opening a
  "Sign out" menu; exercised it end-to-end (signed out, redirected to `/login`, signed back in
  as a different user). Screenshot: `screenshots/09-signout-menu-verified.jpg`.
- Bonus fix not in the original report: the stale "fill in as the HQRP analytics surface (M30)
  lands" copy flagged as a minor style note *was* fixed too (`hqrp-compliance-dashboard.tsx`).

**Finding 3 (scroll-reset) — fix shipped, but does not actually work. New root cause identified.**

The fix added `mainRef.current.scrollTo(0, 0)` on route change, on the theory (stated in its own
code comment) that `.wx-main` is the app's scroll container. Reproduced the original bug twice
post-fix — once by manually scrolling the Home dashboard and clicking a tile, once purely by
clicking a sidebar link far enough down that the browser's own `scrollIntoView` (used to bring
the link into view before clicking) triggered it with no manual scrolling at all. Both times the
destination page rendered fully blank. Screenshots: `screenshots/10-scroll-reset-fix-incomplete.jpg`,
`screenshots/13-scroll-reset-fix-incomplete-refclick.jpg`.

Root cause, confirmed via direct DOM inspection: `main.scrollTop` is `0` (the fix's own target
*did* get reset) but `main`'s `getBoundingClientRect()` still shows a large negative `top` — because
it's **`window.scrollY`** that's nonzero (595px–2000px in the two reproductions), not `.wx-main`'s
internal scroll. `.wx-main`'s `clientHeight === scrollHeight` (both ~5687px on the Reports page) —
its `overflow: auto` (`apps/web/src/index.css:365`) never actually engages, because nothing above
it in the ancestor chain clips to viewport height:

```
apps/web/src/index.css:222   .wx-shell { min-height: 100vh; }   /* should be height: 100vh (or 100dvh) */
apps/web/src/index.css:329   .wx-body  { flex: 1; min-height: 0; }   /* correct, but has nothing to fill */
apps/web/src/index.css:365   .wx-main  { flex: 1; overflow: auto; }  /* correct, but never gets a bounded box */
```

`min-height: 100vh` lets `.wx-shell` grow taller than the viewport to fit its content, so
`.wx-body`'s `flex: 1` has no fixed remaining-height box to fill — the whole flex column just
grows, and the **browser window** scrolls instead of `.wx-main` scrolling internally. This also
means the sidebar's own `overflow-y: auto` (`.wx-nav`, line 340) is equally dead — the two-pane
independent-scroll design the CSS is written for doesn't actually take effect anywhere in the
app; screenshots throughout this whole audit show the sidebar and main content scrolling
together as one page, which is the same symptom.

**Fix:** change `.wx-shell`'s `min-height: 100vh` to `height: 100vh` (or `100dvh` to handle
mobile browser chrome), which lets the existing `flex: 1; min-height: 0; overflow: auto` chain
on `.wx-body`/`.wx-main`/`.wx-nav` do what it's already written to do. Once that's true,
`mainRef.current.scrollTo(0, 0)` becomes correct and unnecessary changes further.

**Applied and verified fixed** — `apps/web/src/index.css:228-233` now reads `height: 100vh;
height: 100dvh;` (the second declaration falls back cleanly on browsers that don't parse
`dvh`). Re-ran both original reproductions:
- Deep-scrolled the Home dashboard, clicked a tile → destination rendered visibly at the top,
  no manual scroll needed.
- Repeated the pure `scrollIntoView`-via-`find`+click reproduction (no manual scrolling at all)
  → same clean result.

Confirmed via DOM inspection post-fix: `window.scrollY: 0`, `main.clientHeight === main.scrollHeight`
(751px, fits the viewport with no internal overflow needed on a short page), `mainRect.top: 63.8px`
(just below the header, not a large negative offset). Also newly observable: scrolling a long page
now moves *only* `.wx-main` — the sidebar nav stays independently scrolled to wherever it was, which
is the two-pane layout the CSS was always written to produce. Screenshot:
`screenshots/15-scroll-and-kpi-fixes-verified.jpg`.

---

## New finding from the follow-up pass

### 8. Staff Management shows literal "0" KPIs when the request actually failed with 403

**Severity: P3** (misleading, low-risk — the page does show a small red error string alongside)

Logged in as Clinician and navigated directly to `/admin/staff` (reachable by URL even though
the nav correctly hides the tile for this role — expected defense-in-depth, not a security gap;
the server 403s the underlying request). The KPI strip renders **"0 Active staff · 0 Suspended ·
0 Admins · 0 Pending invites · 0 Locked accounts"** exactly as if that were real, fetched data —
the only signal anything went wrong is a small red inline string below the invite form: "Could
not load staff. You may not have permission to manage members." A user who doesn't read that
line could easily read the zeros as "this org has no staff," which is false. Screenshot:
`screenshots/14-staff-mgmt-403-misleading-zeros.jpg`.

**Applied and verified fixed** — `apps/web/src/modules/02-identity/staff-management.tsx` now
tracks a dedicated `loadFailed` boolean, separate from the general-purpose `error` string (which
is reused for later invite/resend/rescind/status-change failures and must NOT blank the KPIs
just because some unrelated later action failed). All 5 KPI values are `number | null` — `null`
only when the roster itself failed to load or no org is bound — and `Kpi` renders `null` as `—`,
matching the same dash convention `formatDate` already uses in this file. Re-tested as Clinician
on `/admin/staff`: all 5 tiles now read `—` instead of `0`, with the same red "Could not load
staff..." string still shown. Screenshot: `screenshots/16-staff-mgmt-kpi-dashes-fixed.jpg`
(compare to the before-state in `14-staff-mgmt-403-misleading-zeros.jpg` — same screen, same
403, tiles now read `—` instead of `0`).

Clinician-role coverage otherwise looked clean: Home dashboard correctly scopes to a much
narrower tile set (no Staff/Billing/Platform/Reports sections), My Action Items and Cosign Queue
both rendered correct empty states with full layout intact (confirming Finding 4's fix
generalizes beyond the Administrator role too).

---

## Findings

### 1. `GET /api/v1/permissions` returns 8 of the org's 816 permissions — Roles & Permissions catalog browser is 99% empty

**Severity: P1** (admin-facing screen is functionally broken for its stated purpose — auditing
the permission catalog — even though the underlying grants are correct)

Screenshot: `screenshots/01-roles-permissions-816-of-8.jpg`

Navigating to **Roles & Permissions** (`/roles`) as Administrator renders the header
**"Administrator — 816 of 8 permissions"** and a permission list showing only 8 entries
(`role.read`, `role.manage`, `role.assign`, `breakglass.invoke`, `breakglass.cosign`,
`breakglass.read`, `engagement.manage`, `engagement.read`), even though the role legitimately
holds 816 granted permissions (confirmed independently via Staff Management and the local
`permission` table, which has exactly 816 rows).

**Root cause, confirmed by reading the code and hitting the endpoint directly from the page's
own session** (`fetch('/api/v1/permissions')` → `{"permissions":[...]}, length: 8`):

- `apps/backend/src/modules/03-authorization/routes/authz-routes.ts:118-120` — the route
  handler for `GET /api/v1/permissions` calls `permissionMirrorRows()`.
- `packages/auth/src/permissions/catalog.ts` — `permissionMirrorRows()` returns only the
  `PERMISSIONS` const, which is **deliberately locked to exactly M3's 8 cross-cutting keys**
  (a unit test pins it, per the file's own comment: *"the LOCKED `PERMISSIONS` const... a unit
  test pins it to exactly those eight keys"*).
- `packages/auth/src/permissions/contributed.ts:5861` — the other 808 keys (all 39 other
  modules' contributions) live in `CONTRIBUTED_PERMISSIONS` + per-module consts, aggregated by
  `allPermissionMirrorRows()` — which the route never calls.
- The frontend's count label is at
  `apps/web/src/modules/03-authorization/roles-permissions.tsx:174`:
  `` {role.name} — {granted.size} of {catalog.length} permissions `` — `catalog.length` is 8
  because that's what the API actually returned, not a frontend bug.

**Fix:** swap `permissionMirrorRows()` → `allPermissionMirrorRows()` at
`authz-routes.ts:120`. Authorization enforcement itself is unaffected (every route already
imports its own module's contributed consts for `requirePermission`/`requireAbac` checks) —
this only breaks the read-only catalog browser.

---

### 2. "Platform" nav section is shown to org-scoped admins but every screen in it 403s

**Severity: P2** (UX — dead navigation items; not a security hole, ABAC is correctly denying)

Screenshots: `screenshots/08-feature-flags-403.jpg`, `screenshots/07-web-home-dashboard.jpg`

The web app's Home dashboard and left nav show a full **"Platform"** section to the
org-scoped Administrator: Cap Constants, Reporting Admin, Tenants, Support Sessions, DSAR
Exports, Tenant Exports, Onboarding Templates, Feature Flags, BAA Register, Signup Intents,
Key Rings. Every one tested (`/onboarding/templates`, `/feature-flags`) returns **403** for
this user:

```
GET /api/v1/platform/onboarding-templates?limit=100 → 403
{"error":{"code":"FORBIDDEN","message":"abac predicate 'tenant_lifecycle_platform_ops' denied for 'onboarding_template.list'", ...}}
```

Confirmed on the separate **admin console app** (`:5175`) that this is a real role/app split,
not a config accident: its nav rail only shows M35 subscription-billing screens (Outbox,
Plans, Promos, Subscriptions, Refunds, Dunning, Revenue, Stripe webhooks) for this session —
none of the seeded local demo accounts (`admin@`, `orgadmin@`, `casey@`, `avery@wardenx.local`,
per `CREDENTIALS.local.md`) hold an actual `platform_ops` role, so the fuller platform console
surface (Tenants, DSAR, etc.) couldn't be reached in this pass either — worth re-testing with
a genuine `platform_ops` seed account.

**The correct behavior is the 403** (ABAC is doing its job); the gap is that the **tenant
web app's nav shouldn't be advertising platform-ops-only screens to org admins at all** — they
belong exclusively behind the admin console app. Every org admin in every real tenant will see
11 nav tiles that always fail.

---

### 3. Client-side route navigation doesn't reset scroll — can land on an apparently blank page

**Severity: P3** (cosmetic but confusing; recoverable by manually scrolling)

Reproduced once: scrolled ~1500px down the Home dashboard's long tile grid, then clicked a
tile via coordinates that (correctly) hit "Onboarding Templates." The destination page
rendered with **zero visible content** — fully blank below the header — even though
`get_page_text` confirmed real DOM content ("Onboarding Templates / Unavailable / Could not
load onboarding templates.") was present. `getBoundingClientRect()` on `<main>` showed
`top: -536px`, i.e. the viewport was still scrolled to where the *previous* (long) page's
content had been, and the new, short page's content was rendered off-screen above the
viewport. A clean full navigation to the same URL rendered correctly and visibly (see Finding
2's evidence) — so this is not a persistent component bug, just a missing scroll-restoration
on SPA route change when the user was scrolled deep into a long page beforehand. Given how
long the Home dashboard tile grid is (many hundreds of pixels — see
`screenshots/07-web-home-dashboard.jpg`), this is realistically reproducible by any admin user
browsing the dashboard normally.

**Suggested fix:** scroll the main content region to top on route change in
`apps/web/src/shell/layout.tsx` (or wherever the router is configured) — a standard SPA
scroll-restoration fix.

---

### 4. Patient-chart sub-navigation vanishes on loading/error/empty states — repeats across 5 modules

**Severity: P1** (frequently reproducible; traps the user with no way back except browser-back)

Screenshots: `screenshots/04-patient-summary-with-subnav.jpg` (normal — full sub-nav visible)
vs. `screenshots/02-care-plan-empty-no-subnav.jpg` (same patient, Care Plan tab — sub-nav gone)

Opening a patient chart's **Summary** tab shows a persistent second-level nav column
(Demographics, Addresses, Coverage/Payers, Care Team, Care Plan, Encounters, Assessments,
Orders, Medications, Documents, Election & Certification, IDG History). Clicking into **Care
Plan** for a patient who has no signed IPOC yet (a very common state — any patient early in
admission) renders **"No care plan yet"** with the entire sub-nav column gone — not just
visually hidden, confirmed absent from the DOM via `read_page` (only the top-level admin nav
links remained in the interactive-elements list). The user is stranded with no in-app way back
into the rest of the chart short of the browser's back button.

**Root cause:** `apps/web/src/modules/07-care-plan/care-plan-view.tsx:146-154` — the
`loading`, `error`, and `empty`/`!plan` early returns all bail out with a bare
`<EmptyState .../>` / `<LoadingSpinner />`, skipping the `PatientWorkspaceLayout` wrapper that
the sub-nav lives inside. This is only reached on the *success* path further down
(line 161+).

**This is not isolated** — the identical anti-pattern (`if (loading) return <LoadingSpinner />`
with no layout wrapper) exists in at least 4 more patient/case-chart tab views:

| File | Line |
|---|---|
| `apps/web/src/modules/07-care-plan/care-plan-view.tsx` | 146 |
| `apps/web/src/modules/08-encounters/encounter-read.tsx` | 190 |
| `apps/web/src/modules/09-assessments/assessment-timeline.tsx` | 103 |
| `apps/web/src/modules/15-discipline-care-plans/plan-workspace.tsx` | 160 |
| `apps/web/src/modules/39-consent/consent-detail.tsx` | 287 |

Every one of these briefly drops the sub-nav on *every* tab switch while the API call is in
flight (the common case), and drops it durably on any transient error or the Care Plan tab's
legitimate empty state. Worth a shared fix — e.g. a `PatientWorkspaceLayout` variant that
takes `loading`/`error`/`empty` props and keeps the nav mounted, rather than each screen
reimplementing its own early-return.

---

### 5. Triage Queue shows raw engineering/spec commentary as end-user copy

**Severity: P2** (content quality — inappropriate for a production clinical UI, not a defect)

Screenshot: `screenshots/03-triage-queue-leaked-spec-copy.jpg`

The on-call **Triage Queue** screen (`/triage`) shows, directly in the product UI visible to
on-call clinicians:

> *""Documented — pending encounter" stays ON the board deliberately (M19-F06 / ADR-0022): a
> call stranded by an unreachable M8 encounter seam must remain visible to the supervisor, not
> drop off because its disposition was picked."*

> *"§5.1 sketches "ack / take / re-route" row actions. None is built, because §4.1 publishes
> no assign, claim or re-route route and `triage_call` has no assignee column: the covering
> SHIFT is the assignment and the server resolves it at open. A row action here would have had
> to invent a write nobody can audit. Acknowledging an escalation is a real write and lives on
> the escalation inbox, where the row it acts on is."*

These are internal design-rationale notes (spec section numbers, ADR references, module task
IDs) written directly into `<Card>` components rendered to end users, at
`apps/web/src/modules/19-oncall/triage-queue.tsx:184` and `:257-259`. This reads as
appropriate PR-description or code-comment content, not user-facing product copy — a hospice
on-call nurse or triage coordinator has no context for "§4.1" or "ADR-0022." Worth rewriting
as plain operational language (or removing the second card entirely and moving the rationale
to a code comment) before this ships to a real user.

---

### 6. No sign-out control anywhere in the main web app shell

**Severity: P2** (usability/security-hygiene — relevant for shared clinical workstations)

Clicking the signed-in user's name in the header (`apps/web/src/shell/layout.tsx:55-57`,
`<span className="wx-actor">{session.displayName}</span>`) does nothing — it's inert text, not
a button. Checked the **Account** admin screen (`/admin/account`) as the next likely place —
no sign-out control there either (just Lifecycle/Onboarding/BAA/Contacts cards). Grepping the
frontend confirms the *only* `signOut()` call in the whole app is buried inside the idle-lock
re-authentication modal (`apps/web/src/modules/02-identity/screen-lock.tsx:128`, surfaced as a
"Sign out instead" escape hatch when re-auth is being demanded after inactivity) — there is no
direct, discoverable way for a user to sign out at will. In a multi-user hospice environment
with shared workstations across shifts, this is a real gap: a user finishing a shift on a
shared device has no in-app way to end their session.

---

### 7. Local `wardenx_app` DB role password had drifted from `.env` — backend silently non-functional

**Severity: local-environment issue, not a product bug** — recorded because it blocked
startup and is a real trap for anyone else setting up this environment.

The backend process (already running from a prior session) had crashed and stayed in a
non-listening zombie state; `curl :3000` returned connection-refused. A fresh
`bun run dev:backend` failed immediately with:

```
error: password authentication failed for user "wardenx_app"
```

`.env`'s `DATABASE_URL` password (`wardenx_app`) no longer matched the role's actual Postgres
password, even though the role existed with `rolbypassrls=t, rolcanlogin=t`. Fixed
non-destructively via `ALTER ROLE wardenx_app LOGIN PASSWORD 'wardenx_app';` against the
superuser connection — did not touch data or re-run migrations. Backend then booted clean.

---

## Self-disclosed gaps from the backend boot log (not newly discovered — logged here for completeness)

The backend's own startup log is unusually candid about its known local-environment
limitations; worth recording as a snapshot rather than re-deriving:

- 4 in-memory bindings standing behind production contracts (M34 tenant eraser, M2
  magic-link store, M3 auditor-engagement console, M22 document-render write store) —
  each logs its own module/fix pointer at boot.
- `DATABASE_PLATFORM_URL` not configured locally → the M1→M30/M33 outbox dispatcher and
  several platform-cron jobs (M25/M26/M27/M30/M33 `platform.bypass_invoked` audit writes,
  M26 cap-nightly-projection active-org enumeration) fail-closed into the BullMQ DLQ every
  run. This matches the documented "M30 seam + measure wiring" gaps in project memory —
  not a new finding, just confirmed still true as of this session.
- M23/M24 launch workers explicitly disabled (`configure X12 and MAC gateway URLs`, `configure
  M24_LAUNCH_GATEWAY_ENABLED and M24_CREDENTIAL_ENCRYPTION_KEY`) — expected for local dev.

---

## Minor style notes (not filed as standalone findings — low confidence / low impact)

- **Zero-state KPI inconsistency:** some dashboard tiles render an empty/zero metric as `—`
  (Patients census: "Admissions —", "Discharges —") while others render literal `0`
  (Feature Flags: "Total flags 0"; Cost Reports: "Total reports 0"). Pick one convention.
- **Stale "M30 lands" copy:** HQRP Compliance (`/hope/compliance`) reads *"The 90-day trend
  sparklines... fill in as the HQRP analytics surface (M30) lands"* — per project docs M30 has
  already merged (PR #106+). This copy predates that merge and should be updated or the
  sparklines should actually be wired now that the module exists.

---

## Not covered (still true after the follow-up pass)

- Portal app (`:5174`) beyond the login screen — magic-link auth means no seeded password
  account could complete sign-in without an email-capture step; authenticated portal screens
  are unverified.
- Admin console (`:5175`) beyond the home shell — no seeded `platform_ops` demo account exists
  locally (see Finding 2), so Tenants/Support Sessions/DSAR/Key Rings screens weren't reachable
  in either pass.
- Compliance Auditor (`avery@`) role-gated views — Clinician was covered in the follow-up pass;
  Auditor still hasn't been role-switched to.
- The other ~240 screens in the 271-screen corpus not listed above.
