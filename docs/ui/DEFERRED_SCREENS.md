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
| 1 | M2 | Authentication & Session | `screens/core/WARDENX_UI_AUTH.md` | Auth Flow | ✓ `CenteredCardLayout` | done¹ |
| 2 | M1+M2+M3 | App Shell & Role Home | `screens/core/WARDENX_UI_APP_SHELL_HOME.md` | App Shell | ✓ shell (F0-T03) | done³ |
| 3 | M1 | System / Utility Pages | `screens/core/WARDENX_UI_SYSTEM_UTILITY_PAGES.md` | System Page | ✓ `CenteredStatusLayout` | done |
| 4 | M5 | Patient Chart | `screens/clinical/WARDENX_UI_PATIENT_CHART.md` | Patient Workspace | ✓ `PatientWorkspaceLayout` | done (frame) |
| 5 | M5 | Patient List / Census | `screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md` | Work Queue | ✓ `WorkQueueLayout` | done² |
| 6 | M3 | Roles & Permissions | `screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md` | Admin Split Layout | ✓ `AdminSplitLayout` | done |
| 7 | M4 | Audit Log Viewer | `screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md` | Work Queue | ✓ `WorkQueueLayout` | done |
| 8 | M36 | Internal Staff Secure Messaging | `screens/core/WARDENX_UI_STAFF_MESSAGING.md` | Conversation View | ✓ `ConversationView` | done |
| 9 | M36 | Notifications & Tasks / Worklist | `screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md` | Work Queue | ✓ `WorkQueueLayout` | done |
| 10 | M38 | Terminology / Reference Data | `screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md` | Work Queue | ✓ `WorkQueueLayout` | done (live)⁶ |
| 11 | M40 | Master Data Management | `screens/admin/WARDENX_UI_MASTER_DATA_MDM.md` | Work Queue | ✓ `WorkQueueLayout` | done (live)⁷ |

> Patient Chart (#4) is a hub: its M5 frame (banner + summary + module nav rail) is buildable now; the
> per-module tabs (encounters, orders, eMAR, …) fill in as those modules land — build the frame in
> Track A, graft tabs in Track B.

> ⁶ **M38 Terminology — now LIVE end-to-end (FB-T01).** The terminology routes are mounted in the
> composition root (`registerTerminologyRoutes` in `apps/backend/src/index.ts`), and the published
> `TerminologyProvider` seam is backed by a real Drizzle `TerminologyStore`
> (`apps/backend/src/modules/38-terminology/terminology-store-db.ts`) over the M38 tables — concept
> reads (validate / lookup / search) on the four Phase-1 per-system tables, value-set
> expand / is-member over `value_set_member` (display resolved as-of from the concept tables), and the
> org-scoped add-only tenant value-set extensions under `withOrgContext`/RLS. Platform reference reads
> serve via the `USING (true)` policy; canonical writes stay impossible (§7.4). The Terminology Admin
> screen (`/admin/terminology`) now hits live endpoints instead of 404s. No new routes (already in the
> contract), so `openapi.json`/the client are unchanged. RLS isolation for the one org-scoped table is
> covered by `rls-isolation.live.test.ts` (§7.4 lockdown + §9.4 org-scoping).

> ⁷ **M40 Master Data Management — now LIVE end-to-end (FB-T02).** The MDM routes are mounted in the
> composition root (`mountMdmRoutes` in `apps/backend/src/index.ts`), and BOTH published seams —
> `MdmEntityProvider` (§4.5) and `BaaStatusProvider` (§4.6/§7.7 as-of gate) — are backed by real
> Drizzle stores (`apps/backend/src/modules/40-mdm/mdm-store-db.ts`) over the M40 tables. The
> entity-directory **read** surface the console consumes (`GET /api/v1/mdm/{kind}/search`, resolve,
> relationships) is live: canonical reads (physician/facility/payer) serve via the `USING (true)`
> policy on the pooled handle; the org-scoped physician overlay + the tenant BAA register read/write
> under `withOrgContext`/RLS; `mdm_provisional` proposals insert under RLS. The MDM console
> (`/admin/mdm`) now hits live endpoints instead of 404s. The §7.6 platform-ops governance **writes**
> (merge approve/reject, provisional promote) stay deferred — they need the `mdm_canonical_writer`
> SECURITY DEFINER functions (a deeper M40 surface), so they fail-clear with 501 rather than corrupt
> the redirect graph; the merge-queue / NPPES-sync-log / on-demand-NPI **reads** are wired (wardenx_admin
> break-glass surface). No new routes (already in the contract), so `openapi.json`/the client are
> unchanged. RLS isolation for the org-scoped overlay/BAA/provisional tables is covered by
> `rls-isolation.live.test.ts`.

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

> ¹ **M2 Auth — mostly built + live-verified.** Better Auth is mounted, and email+password sign-in **and
> 2FA-at-rest encryption are verified against real Postgres** (AUTH wave + ADR-0033/0034). Built screens
> in `apps/web/src/modules/02-identity` (registered in the shell): **Sign in** (`/login`), **MFA
> challenge** (`/login/2fa`, TOTP + backup code via `@wardenx/auth/client`'s `twoFactor` plugin),
> **Passkeys** (`/security/passkeys`, register/manage WebAuthn + "Sign in with a passkey" on `/login`,
> via the `passkey` client plugin — the ceremony is browser-only, so build-/e2e-verified, not CI),
> **Organization Select** (`/login/organization`), **Accept Invitation** (`/invite/:token`),
> **Password reset** (`/forgot` → `/reset-password?token=…`, via Better Auth `requestPasswordReset` /
> `resetPassword` — email delivery wired to M36 in a follow-up, like magic-link), **Step-up**
> (`/step-up?returnTo=…` — fresh re-verification of the current session via the generated REST client
> over `POST /api/v1/sessions/step-up{/initiate}`; paired-writes `lastStepUpAt`/`lastStepUpFactor` that
> M3's `step_up_recent` gates on. TOTP is wired; the WebAuthn step-up ceremony is a browser follow-up
> like passkey), and the **idle screen-lock** (an overlay, not a route: the composition root mounts it
> inside the app shell via the new `AppShell chromeOverlay` seam — M1 stays module-free; after
> `SESSION_POLICY.screenLockSec` = 5 min idle it covers the authenticated frame and soft-re-auths the
> same user by password, session stays alive per M2 §2.2.4 active→screen_locked→active; gated to the
> `SESSION_POLICY.screenLockClasses` floor = staff/auditor, an unknown class failing safe). **No M2 auth
> screens remain deferred.** Backend follow-ups only: WebAuthn step-up ceremony, magic-link M36 delivery,
> actor role/membership enrichment (the M2↔M3 seam).

### Partial — primary owner merged, but key sections need unbuilt modules

| Module(s) | Screen | Spec | Blocked-on | Status |
|-----------|--------|------|-----------|--------|
| M5 + M2/M3 | Global Search Results | `screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md` | aggregates entities from later modules; M5 patient search ready | deferred (partial) |
| M2 + M36 + M17 | User Profile & Preferences | `screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md` | M17 (scheduling prefs) | deferred (partial) |
| M2 / M34 | Staff Management | `screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md` | owner = M2 (memberships); Name/email, Discipline, Credentials, Last-login, Pending-invite/Locked KPIs need richer member data / M34 | done (M2 roster)⁵ |

> ⁵ **Staff Management — built at the M2 roster level** (`apps/web/src/modules/02-identity/staff-management.tsx`,
> `/admin/staff`, Work Queue). Invite by email, change member status (active/suspended), and revoke a
> membership — over the M2 member routes via the generated client; active org from the session. Owner
> question resolved: **M2** (memberships). Deferred to richer member data / M34: Name/email, Discipline,
> Credentials, Last-login columns and the Pending-invite / Locked-account KPIs. Like every Track A screen,
> this is built against the typed contract; the M2 member routes are coded + unit-tested (Fastify `inject`)
> but **not yet mounted in the running server**, and the membership store is in-memory — a backend
> mount + DB-store follow-up shared across all modules.

### M39 Consent — no standalone staff screen (backend now LIVE, FB-T03)

M39 has no dedicated screen in the index; consent surfaces inside **Patient Chart** (a tab, #4) and the
patient-facing **Portal Documents/Consents** (M31, blocked). No separate Track A row — covered by #4.

**M39 backend now LIVE end-to-end (FB-T03).** The consent routes are mounted in the composition root
(`mountConsentRoutes` in `apps/backend/src/index.ts`), and the published `ConsentEvaluator` seam (§4.3,
the disclosure/redaction gate) is backed by a real Drizzle `ConsentStore`
(`apps/backend/src/modules/39-consent/consent-store-db.ts`) over the M39 tables. The consent **read**
surface the Patient Chart consent tab (FB-T10) consumes is live: the platform-shared `consent_type_catalog`
serves on the pooled handle; the patient's active consents (`GET /api/v1/patients/:id/consents`), a single
record, and the cursor-paginated decision audit run under `withOrgContext`/RLS. The consent-**lifecycle**
writes (create-draft / sign / revoke) stay deferred — they need the §2.2.1 capture/step-up-evidence +
append-only supersession + per-tenant DEK machinery (M39-T09 consent-flow surface), so they fail-clear with
501 rather than write a half-formed append-only record. The `consent` eraser still refuses §3.8 (legal-hold
/ 42 CFR Part 2 lifetime). `isPatientDeceased` (D13 post-death scope) returns false until the
`m5.patient.deceased` outbox consumer + its M1 infra wire (M39-T08). No new routes (already in the
contract), so `openapi.json`/the client are unchanged.

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
