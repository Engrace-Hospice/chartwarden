# WardenX — Deferred Screens Ledger (Track A backlog + coordination point)

The single status source for frontend screens, per `docs/plans/FRONTEND_INTEGRATION_PLAN.md` (F0-T05).
Every backend module task so far ended "screens defer (no UI codePath)". This ledger is the **Track A
worklist** — the screens whose backend module is already merged to `main` and can now be built — and
the **coordination point** with Track B (per-module screens going forward): mark a row `done` so the
other track skips it.

**Governing ADRs:** [ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md) (placement: each module
owns `apps/web/src/modules/NN-*`, registered into the M1 shell), [ADR-0032](../adr/ADR-0032-frontend-api-transport-and-client.md)
(typed client). Screen specs live under `docs/ui/screens/`; layout patterns in
`WARDENX_UI_LAYOUT_PATTERNS.md`; module ownership is the `Module:` line in each spec.

**Build rule (backend-first):** a screen is only built after its module's routes/seams are on `main`,
and against the generated client (`packages/ui/src/api`). No new authz on the frontend — the server
stays authoritative.

**Status legend:** `deferred` (not started) · `in-progress` · `done`. **Layout** notes whether the
F0-T04 `@wardenx/ui` layout component already exists (✓) or ships with the screen (—).

---

## Merged backend modules (Track A is unblocked for these)

M1 (Foundation/shell), M2 (Identity), M3 (Authorization), M4 (Audit), M5 (Patient), M36 (Messaging),
M38 (Terminology), M39 (Consent), M40 (MDM). Build order below follows value + dependency
(M2 auth gates everything; M5 is the clinical spine).

### Ready now — Track A worklist

| # | Module | Screen | Spec | Layout pattern | Layout cmp | Status |
|---|--------|--------|------|----------------|-----------|--------|
| 1 | M2 | Authentication & Session | `screens/core/WARDENX_UI_AUTH.md` | Auth Flow | ✓ `CenteredCardLayout` | in-progress¹ |
| 2 | M1+M2+M3 | App Shell & Role Home | `screens/core/WARDENX_UI_APP_SHELL_HOME.md` | App Shell | ✓ shell (F0-T03) | done³ |
| 3 | M1 | System / Utility Pages | `screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md` | System Page | ✓ `CenteredStatusLayout` | done |
| 4 | M5 | Patient Chart | `screens/clinical/WARDENX_UI_PATIENT_CHART.md` | Patient Workspace | ✓ `PatientWorkspaceLayout` | done (frame) |
| 5 | M5 | Patient List / Census | `screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md` | Work Queue | ✓ `WorkQueueLayout` | done² |
| 6 | M3 | Roles & Permissions | `screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md` | Admin Split Layout | ✓ `AdminSplitLayout` | done |
| 7 | M4 | Audit Log Viewer | `screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md` | Work Queue | ✓ `WorkQueueLayout` | done |
| 8 | M36 | Internal Staff Secure Messaging | `screens/core/WARDENX_UI_STAFF_MESSAGING.md` | Conversation View | ✓ `ConversationView` | done |
| 9 | M36 | Notifications & Tasks / Worklist | `screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md` | Work Queue | ✓ `WorkQueueLayout` | done |
| 10 | M38 | Terminology / Reference Data | `screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md` | Work Queue | ✓ `WorkQueueLayout` | done |
| 11 | M40 | Master Data Management | `screens/admin/WARDENX_UI_MASTER_DATA_MDM.md` | Work Queue | ✓ `WorkQueueLayout` | done |

> Patient Chart (#4) is a hub: its M5 frame (banner + summary + module nav rail) is buildable now; the
> per-module tabs (encounters, orders, eMAR, …) fill in as those modules land — build the frame in
> Track A, graft tabs in Track B.

> ³ **App Shell / Role Home — done at frame level.** The App Shell chrome is F0-T03; the Role Home now
> renders at `/` (apps/web/src/shell/role-home.tsx): role-aware greeting + quick-access tiles for the
> registered screens, grouped by nav group — it auto-populates as Track A/B add screens. Role-specific
> data widgets (My Patients, AR snapshot, cosign queue…) and the richer Top Nav (org switcher, global
> search, notifications bell, user menu) arrive with their modules (M36, Global Search, M2 auth backend).

> ² **M5 Patient Census — built, and it required a backend route.** M5 had no list/search endpoint, so
> a cursor-paginated `GET /api/v1/patients` (name/MRN search + status filter) was added to the M5 backend
> first, then the `PatientListCensus` screen (`/patients`) built against it. Row → `/patients/:id` (the
> Patient Chart, #4, not built yet). The "M5 patient search ready" note above referred to a server-side
> seam, not HTTP — now there is a real list route.

> ¹ **M2 Auth — partially built (first Track A screen).** The flows backed by real M2 routes are done in
> `apps/web/src/modules/02-identity` and registered in the shell: **Organization Select**
> (`/login/organization`) and **Accept Invitation** token-consume (`/invite/:token`). The remaining
> spec flows — **Sign in, MFA challenge, password reset, screen-lock** — are **blocked on the identity
> credential backend (better-auth), which is not yet mounted** in `apps/backend`. Mounting better-auth
> (and wiring those routes into the OpenAPI contract) is a **backend follow-up**; the screens then plug
> into the same shell + client. The M2 routes were enriched into the contract (`scripts/openapi/enrichments.ts`).

### Partial — primary owner merged, but key sections need unbuilt modules

| Module(s) | Screen | Spec | Blocked-on | Status |
|-----------|--------|------|-----------|--------|
| M5 + M2/M3 | Global Search Results | `screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md` | aggregates entities from later modules; M5 patient search ready | deferred (partial) |
| M2 + M36 + M17 | User Profile & Preferences | `screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md` | M17 (scheduling prefs) | deferred (partial) |
| M2 / M34 | Staff Management | `screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md` | confirm owner M2 (memberships) vs M34 | deferred (partial) |

### M39 Consent — no standalone staff screen

M39 has no dedicated screen in the index; consent surfaces inside **Patient Chart** (a tab, #4) and the
patient-facing **Portal Documents/Consents** (M31, blocked). No separate Track A row — covered by #4.

---

## Blocked on later waves (out of Track A scope until their module lands)

The remaining ~50 screens (clinical suite, revenue, portal, platform/ops) are owned by modules not yet
built (M6–M35, M37). They are **Track B**: each ships with its module's wave (include the
`apps/web/src/modules/NN-*` codePath from T01; the terminal screen task builds it). Examples:
Admissions/Intake (M6), Care Plan (M7+M15), Encounters (M8), Assessments (M9), HOPE (M10), Orders (M11),
eMAR (M12+M13), IDG (M14), Scheduling (M17), EVV (M18), Claims (M23+M24), Cap (M26), Cost Report (M27),
FHIR (M28), HQRP (M30), Portal/Telehealth (M31), Copilot (M32), Reporting (M33), Onboarding (M34),
Subscription (M35), IPU Bed Board (M37). See each spec's `Module:` line for the authoritative owner.

---

## How to use this ledger

- **Track A** (dedicated backlog wave): pick the next `deferred` row above, add the module's
  `apps/web/src/modules/NN-slug` codePath to the manifest (+`.cjs`), `bun run scaffold`, build the
  screen against the generated client + the layout component, register it into the M1 shell, set the
  row `done`.
- **Track B** (per-module, going forward): when a blocked module is built, its screen ships in-wave;
  mark its row `done` here so Track A never double-builds it.
