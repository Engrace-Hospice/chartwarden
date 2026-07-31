# WardenX — Deferred Screens Ledger (Track A backlog + coordination point)

The single status source for frontend screens, per `docs/plans/FRONTEND_INTEGRATION_PLAN.md` (F0-T05).
Every backend module task so far ended "screens defer (no UI codePath)". This ledger is the **Track A
worklist** — the screens whose backend module is already merged to `main` and can now be built — and
the **coordination point** with Track B (per-module screens going forward): mark a row `done` so the
other track skips it.

**Governing ADRs:** [ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md) (placement: each module
owns `apps/web/src/modules/NN-*`, registered into the M1 shell), [ADR-0032](../adr/ADR-0032-frontend-api-transport-and-client.md)
(typed client). Screen specs live under `docs/design/screens/`; layout patterns in
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
| 4 | M5 | Patient Chart | `screens/clinical/WARDENX_UI_PATIENT_CHART.md` | Patient Workspace | ✓ `PatientWorkspaceLayout` | done (frame + Demographics + Addresses + Coverage + Care Team + Privacy Flags tabs)⁴ ⁹ ¹⁰ ¹¹ ¹² |
| 5 | M5 | Patient List / Census | `screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md` | Work Queue | ✓ `WorkQueueLayout` | done² |
| 6 | M3 | Roles & Permissions | `screens/admin/WARDENX_UI_ROLES_PERMISSIONS.md` | Admin Split Layout | ✓ `AdminSplitLayout` | done |
| 7 | M4 | Audit Log Viewer | `screens/admin/WARDENX_UI_AUDIT_LOG_VIEWER.md` | Work Queue | ✓ `WorkQueueLayout` | done |
| 8 | M36 | Internal Staff Secure Messaging | `screens/core/WARDENX_UI_STAFF_MESSAGING.md` | Conversation View | ✓ `ConversationView` | done (live)⁸ |
| 9 | M36 | Notifications & Tasks / Worklist | `screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md` | Work Queue | ✓ `WorkQueueLayout` | done (live)⁸ |
| 10 | M38 | Terminology / Reference Data | `screens/admin/WARDENX_UI_TERMINOLOGY_ADMIN.md` | Work Queue | ✓ `WorkQueueLayout` | done (live)⁶ |
| 11 | M40 | Master Data Management | `screens/admin/WARDENX_UI_MASTER_DATA_MDM.md` | Work Queue | ✓ `WorkQueueLayout` | done (live)⁷ |

> Patient Chart (#4) is a hub: its M5 frame (banner + summary + module nav rail) is buildable now; the
> per-module tabs (encounters, orders, eMAR, …) fill in as those modules land — build the frame in
> Track A, graft tabs in Track B.

> ⁴ **Patient Chart — Demographics & Identifiers tab now LIVE (FB-T06).** The M5-owned tab reads live
> M5 data via two new gated GET routes — `GET /api/v1/patients/:id/demographics` (legal name parts,
> DOB, the USCDI SOGI/race/ethnicity/marital codes, preferred language, and name aliases) and
> `GET /api/v1/patients/:id/identifiers` — both behind `requirePermission("patient.read")` and RLS-scoped
> by the request org. **§2.2/§3.3 masking is enforced server-side, by construction:** `ssn`/`state_id`
> identifiers return `value: null` and only the `value_last4` tail (`xxx-xx-####`) — the `value_encrypted`
> ciphertext is *never selected*, so there is no decrypt path and no leak. MRN is flagged immutable.
> Full SSN/state-ID reveal stays gated on `phi.read_ssn` (already in M5's catalog) and lands with the M5
> SSN capture/decryption write-path follow-up. The remaining M5-owned tabs (Coverage FB-T08, Care Team
> FB-T09, Privacy/Consent FB-T10) follow; cross-module tabs stay Track B.
>
> ⁹ **Patient Chart — Addresses tab now LIVE (FB-T07).** The M5-owned tab renders the D5 **append-only**
> address history via a new gated `GET /api/v1/patients/:id/addresses` (`requirePermission("patient.read")`,
> RLS-scoped, 404-no-leak on an out-of-org/absent patient). It shows the **current** rows (`effective_to IS
> NULL`) — at most one current **primary** per patient — plus closed rows as history, and an add-address
> form over the live M5 write path (`POST …/addresses`). Setting **primary** performs **atomic rotation**
> in one `withOrgContext` transaction: the prior current primary is closed (`effective_to` set, freeing the
> `is_primary && effective_to IS NULL` partial unique index) before the new row is appended — never an
> overwrite. A **geocode badge** reflects whether the async M5 geocode job has filled lat/lng yet
> (`geocoded` vs `geocoding…`). Verified end-to-end (list/add/rotate) by route tests; the live-PG path
> (which alone exercises the partial-unique-index interaction) is covered in `auth.live.test.ts`.
>
> ¹⁰ **Patient Chart — Coverage / Payers tab now LIVE (FB-T08).** The M5-owned tab renders the §3.4
> `patient_payer` coverages via a new gated `GET /api/v1/patients/:id/payers`
> (`requirePermission("patient.read")`, RLS-scoped, 404-no-leak), backed by the Drizzle
> `PatientRouteService.listPayers` (active coverages first by `effective_to IS NULL`, then by `rank`).
> Each row's `payer_id` names an **M40 canonical Payer**; the display **name** is resolved at the client
> edge through the generated M40 MDM client (`GET /api/v1/mdm/payer/:id` → `canonical.displayName`) — so
> there is **no cross-module backend coupling** (no new `dependsOn` edge, no `packages/db/src/schema/mdm`
> import). A payer the viewer can't resolve (e.g. lacking `mdm.payer.read`) falls back to its raw id,
> never fabricated. Primary (rank 1) is badged; closed coverages render as history.

> ¹¹ **Patient Chart — Care Team & Assignments tab now LIVE (FB-T09).** The M5-owned tab renders three
> §3.4/§3.5 M5-owned lists via a new gated `GET /api/v1/patients/:id/care-team`
> (`requirePermission("patient.read")`, RLS-scoped, 404-no-leak), backed by the Drizzle
> `PatientRouteService.getCareTeam`: the clinical `patient_assignment` roster (active first by
> `unassigned_at IS NULL`), the `patient_caregiver` ⨝ `caregiver` involvements (relationship + primary +
> legal-representative authority), and the priority-ordered `emergency_contact` rows. An assignment's
> clinician is returned as a bare `clinician_user_id` — the staff **display name** crosses into M2, and
> the M2 roster does not yet expose user names (Staff Management enrichment FB-T12 / M34), so the row
> shows its care-team role + the short clinician id honestly rather than a fabricated name. **No
> cross-module backend coupling** (no new `dependsOn` edge, no M2 schema import). Closed assignments /
> ended involvements render under "Past involvement".

> ¹² **Patient Chart — Privacy Flags tab now LIVE (FB-T10).** The consent-gated M5-owned tab composes
> two live reads: the §3.5/D10 `patient_privacy_flag_snapshot` via a new gated
> `GET /api/v1/patients/:id/privacy-flags` (`requirePermission("patient.read")`, RLS-scoped, 404-no-leak),
> backed by the Drizzle `PatientRouteService.getPrivacyFlags` (live row = `invalidated_at IS NULL`); and
> the patient's active consents via the M39 `GET /api/v1/patients/:id/consents` (mounted LIVE in FB-T03,
> RLS-scoped). The snapshot's active **restriction** flags render as badges (a flag present = restricted);
> `sud` is the **42 CFR Part 2** category. **§7.6 fail-closed:** the server decides disclosability with
> the M5 privacy engine (`isSudReadAllowed(flags, false)` — the snapshot flag is the source until the M39
> consent-present signal is wired live), and when a SUD-restricted patient is non-disclosable the Part 2
> surface renders a **redacted** notice rather than fabricated detail. **No cross-module backend coupling**
> (the consents read is M39's own route at the client edge; no new `dependsOn` edge, no M39 schema import).
> This makes **M39's "consent inside Patient Chart" surface (no standalone screen — see below) covered by
> #4**.

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

> ⁸ **M36 Secure Messaging — READ + WRITE paths now LIVE end-to-end (FB-T04 reads, FB-T05 writes).**
> The messaging routes are mounted in the composition root (`mountMessagingRoutes` in
> `apps/backend/src/index.ts`), backed by a real Drizzle `MessagingRouteService`
> (`apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`) over the M36 tables, and the
> `channel_visibility` ABAC predicate is registered against it. The READ surface is live under
> `withOrgContext`/RLS: the channel sidebar (`GET /api/v1/messaging/channels`, with delivered-but-unread
> receipt counts), channel detail + members, the paginated thread envelope, the per-actor alert inbox
> (`GET /api/v1/alerts/inbox`, `alert` ⋈ `notification_delivery`), the SELF notification preferences, and
> the tenant + inherited platform `alert_rule` list (the §7.4 `alert_rule_read` policy serves both in one
> read). **FB-T05 makes the §4.2 WRITE surface live**: message bodies are **envelope-encrypted under the
> per-tenant DEK** (`message.body_cipher` bytea) at write time and **decrypted for entitled readers** on
> the thread read (the shared `messaging-write-core.ts` cipher loads the master KEK
> `MESSAGING_ENCRYPTION_KEY` lazily — a read-only deploy without it still boots). Send / edit / delete
> (tombstone, cipher retained) / read-receipts (delivered-receipt fan-out → markRead) / DM / member admin
> / announce / preference + endpoint mutation / alert-rule override all run live. The cross-module
> `MessagingProvider` seam (`messaging-provider-db.ts`) is registered over the deny-stub when a DB is
> present, so `validateSeams()` sees it **real**; its `sync*` auto-channel hooks remain forward-seam
> deferrals (driven by M5/M16/M17/M19 outbox events not wired in Phase 1). No new routes (already in the
> contract), so `openapi.json`/the client are unchanged. RLS isolation for the org-scoped messaging
> tables — including the FB-T05 message-receipt fan-out and a cross-tenant-write `WITH CHECK` rejection —
> is covered by `rls-isolation.live.test.ts` (CI `rls-live`).

> ³ **App Shell / Role Home — frame done + role-scoped (FB-T15).** The App Shell chrome is F0-T03; the
> Role Home renders at `/` (apps/web/src/shell/role-home.tsx): role-aware greeting + quick-access tiles
> for the registered screens, grouped by nav group. As of FB-T15 the shell **self-loads the actor's
> role/membership context** from the live `GET /api/v1/auth/context` (the M2↔M3 enrichment seam: M3-resolved
> roles + effective permissions over the actor's active membership) via the typed client
> (`apps/web/src/shell/session.tsx` `ActorSessionProvider`), so the greeting reflects the real role/org and
> the nav + Home tiles are **gated to the actor's effective permissions** (`canSeeScreen`, the same keys the
> server enforces — the server stays the sole enforcer, no new client authz). Role-specific data widgets
> (My Patients, AR snapshot, cosign queue…) and the richer Top Nav (org switcher, notifications bell, user
> menu) still arrive with their modules.

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
> `resetPassword` — email delivery now wired to M36's transactional email transport, like magic-link;
> FB-T14), **Step-up**
> (`/step-up?returnTo=…` — fresh re-verification of the current session via the generated REST client
> over `POST /api/v1/sessions/step-up{/initiate}`; paired-writes `lastStepUpAt`/`lastStepUpFactor` that
> M3's `step_up_recent` gates on. BOTH qualifying factors are wired: TOTP, and the **WebAuthn step-up
> ceremony** (FB-T13) — `navigator.credentials.get` against the session-scoped challenge the initiate
> route mints, assertion posted back for server verification; browser-only, so build-/e2e-verified, not
> CI-unit), and the **idle screen-lock** (an overlay, not a route: the composition root mounts it
> inside the app shell via the new `AppShell chromeOverlay` seam — M1 stays module-free; after
> `SESSION_POLICY.screenLockSec` = 5 min idle it covers the authenticated frame and soft-re-auths the
> same user by password, session stays alive per M2 §2.2.4 active→screen_locked→active; gated to the
> `SESSION_POLICY.screenLockClasses` floor = staff/auditor, an unknown class failing safe). **No M2 auth
> screens remain deferred.** Magic-link / password-reset **email delivery is now wired to M36's
> transactional email transport** (`@wardenx/messaging` `selectTransactionalEmailTransport`, bound to the
> auth `EmailTransport` seam at the composition root; DR/INT #14, Postmark = M36; FB-T14) — the real
> Postmark/SES provider plugs into M36's `provider` slot when M1 infra wires credentials. The actor
> role/membership enrichment (the M2↔M3 seam) now ships too: `GET /api/v1/auth/context` exposes the
> actor's M3-resolved roles + effective permissions over their active membership, and the shell self-loads
> it for the role-scoped Role Home / nav (FB-T15, see ³). **No M2 auth backend follow-ups remain.**

### Partial — primary owner merged, but key sections need unbuilt modules

| Module(s) | Screen | Spec | Blocked-on | Status |
|-----------|--------|------|-----------|--------|
| M5 + M2/M3 | Global Search Results | `screens/core/WARDENX_UI_GLOBAL_SEARCH_RESULTS.md` | later facets (documents/orders/visits/commands) need unbuilt modules | done (partial — M5+M2 facets)⁶ |
| M2 + M36 + M17 | User Profile & Preferences | `screens/core/WARDENX_UI_USER_PROFILE_PREFERENCES.md` | M17 (scheduling prefs) | deferred (partial) |
| M2 / M34 | Staff Management | `screens/admin/WARDENX_UI_STAFF_MANAGEMENT.md` | owner = M2 (memberships); enriched (FB-T12) with name/email, last-login, Pending-invite + Locked-account KPIs; Discipline/Credentials still need M34 | done (M2 roster — enriched)⁵ |

> ⁵ **Staff Management — built at the M2 roster level, enriched (FB-T12)** (`apps/web/src/modules/02-identity/staff-management.tsx`,
> `/admin/staff`, Work Queue). Invite by email, change member status (active/suspended), and revoke a
> membership — over the M2 member routes via the generated client; active org from the session. Owner
> question resolved: **M2** (memberships). **FB-T12** enriched the roster with what the M2 surface carries
> today: a **Name / email** column (the live `MembershipRepository` joins the M1-owned `user` table), a
> **Last-login** column (`max(session.created_at)` from the M1-owned `session` table), and two KPIs —
> **Pending invites** (`pendingInvitations` from the members route, counting still-pending
> `organization_invitation` rows) and **Locked accounts** (members whose `user.status` is
> suspended/deactivated, badged inline). All additive read-layer over M1-owned tables (M2 dependsOn 1; no
> new edge, no schema import). Still deferred to **M34**: Discipline / credentials (no fabrication — the
> screen omits them). Like every Track A screen this is built against the typed contract; the member
> roster reads run on the live Drizzle repo, while the remaining M2 lifecycle deps (invitations /
> sessions / user directory) stay in-memory pending a shared backend mount + DB-store follow-up.

> ⁶ **Global Search Results — built (partial — M5 + M2 facets, FB-T11).** The Global Search frame
> (`apps/web/src/modules/05-patient/global-search.tsx`, `/search`, Work Queue: facets + grouped results
> + result preview) ships with its two **live** facets: the M5 **patient** facet over
> `GET /api/v1/patients?q=` (RLS/caseload-scoped server-side; the list carries no SSN/MBI, so the spec's
> redaction holds by construction) and the M2 **staff** facet over `GET /api/v1/orgs/:id/members?q=`
> (server-side `q` added in FB-T11 — narrows by the wrapped user identity; FB-T12 extended `q` to also
> match the joined `user.name` / `user.email`). The staff facet stays behind `member.manage`; a 403 / no
> org-bound session degrades to a clear note, never a hard error. It is reachable from the new shell
> **top-nav search** box (M1 layout, module-free — it only navigates to `/search?q=`). Later facets
> (**documents / orders / visits / navigation-commands**) render as labeled "available when *module*
> ships" rows — visible, not fabricated — and light up with M22 / M16 / M19 (Track B).

### M39 Consent — no standalone staff screen (backend LIVE FB-T03; consent surface LIVE FB-T10)

M39 has no dedicated screen in the index; consent surfaces inside **Patient Chart** (a tab, #4) and the
patient-facing **Portal Documents/Consents** (M31, blocked). No separate Track A row — **covered by #4,
now LIVE**: the Patient Chart **Privacy Flags** tab (FB-T10, footnote ¹²) renders the patient's active
consents from `GET /api/v1/patients/:id/consents` alongside the privacy-flag snapshot, with the §7.6 SUD /
42 CFR Part 2 surface failing closed when non-disclosable.

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

## Track B — shipped in-wave (done)

| Module | Screens built | Spec | Status |
|---|---|---|---|
| M6 | Referral Inbox (§5.2.1), Admission Census (§5.2.12), Admission Detail + activation gate (§5.2.4/§5.2.5), Compliance Dashboard (§5.2.11) | `screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md`, `WARDENX_UI_ELECTION_CERTIFICATION.md` | done (M6-T12)¹³ |
| M7 | Care Plan View (§5.2), Version History (§5.1), Care Plan Summary (§5.2) | `screens/clinical/WARDENX_UI_CARE_PLAN.md` | done (M7-T09)¹⁴ |
| M8 | Encounter Read (§5.2), Cosignature Queue (§5.5), My Drafts (§5.1) | `screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md` | done (M8-T12)¹⁵ |
| M9 | Assessment Timeline (§5.2), Per-scale Trend (§5.2), Significant-change Inbox (§5.2), Assessment Summary (§5.2), Scale-license Registry (§5.2), Scale-policy Editor (§5.2) | `screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md` | done (M9-T07)¹⁶ |
| M10 | HOPE Timepoint Dashboard (§5.2), Patient HOPE Timeline (§5.2), SFV Worklist (§5.2), HOPE Assessment Detail (§5.2), Submission Worklist (§5.2), Submission Detail (§5.2), HQRP Compliance Dashboard (§5.2) | `docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md` §5 | done (M10-T08)¹⁷ |
| M11 | Signature Inbox (§5), Patient Orders (§5), Order Detail (§5), Verbal-Expiring Queue (§5), Cosign-Pending Queue (§5 §2.5), Lab Results-Pending-Review Queue (§5 D17), Standing-Order Admin (§5 §2.4 D5) | `screens/clinical/WARDENX_UI_ORDERS.md` | done (M11-T08)¹⁸ |
| M12 | Patient Medications (§6.1), Medication Detail (§6.1), Medication Sign Inbox (§6.1), Verbal Medication Orders (§6.1), Refill Inbox (§6.1), Refill Detail (§6.1), Medication Reconciliation (§6.1), Prescriber Roster admin (§6.1), Prescribing Policy admin (§6.1) | `screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md` (prescribing half) | done — prescribing (M12-T09)¹⁹ |
| M13 | Patient eMAR (§6.1 #1), Administration Detail (§6.1 #11), IV Continuous Session (§6.1 #5), Missed-Dose Inbox (§6.1 #8), Reconciliation Worksheet (§6.1 #6), Comfort Kit View (§6.1 #7), Administration Policy admin (§6.1 #12) | `screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md` (eMAR half) | done — eMAR administration (M13-T10)²⁰ |
| M14 | IDG Schedule (§5), Meeting Detail (§5), Live Meeting Surface (§5), Per-Patient Packet (§5), My Action Items (§5), Minutes (§5) | `screens/clinical/WARDENX_UI_IDG_MEETING.md` | done — IDG read surfaces (M14-T07)²¹ |
| M17 | Day View (§5.1), Week View (§5.1), Proposal Inbox (§5.1), Recurring Policies (§5.1), Time-Off Queue (§5.1), Visit Detail (§5.1), My Visits (§5.1), Scheduling Metrics (§5.1) | M17 spec §5.1 | done — scheduling read surfaces (M17-T08)²² |
| M18 | EVV Dashboard (§5.1), Event Ledger (§5.1), Event Detail (§5.1), Missing-EVV Resolutions (§5.1), Aggregator Submissions (§5.1), Geofence Policy (§5.1), Devices (§5.1), EVV Metrics (§5.1), My Devices (§5.1) | M18 spec §5.1 | done — EVV read surfaces (M18-T07)²³ |
| M22 | DOC.Explorer (§5.1), DOC.VersionHistory (§5.1), INTAKE.BatchDetail (§5.1), FORM.TemplateLibrary (§5.1) | `docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md` §5.1 | done — Documents read surfaces (M22-T10)²⁴ |

> ¹³ **Admissions/Intake (M6) now LIVE (Track B, M6-T12, ADR-0030).** Built under
> `apps/web/src/modules/06-admission` against M6's generated client methods (the M6 read routes are
> enriched in `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered
> into the M1 shell via `admissionScreens` (`main.tsx`). The §5.2.5 activation-gate checklist renders
> the server's `activationGate.missing[]` verbatim — route 10 and route 14 share one gate helper, so
> UI and server can never diverge. Nav visibility is gated by `referral.read` / `admission.read` /
> `compliance.read`; the SERVER stays the only enforcement point. Detail/editor/wizard sub-screens
> (§5.2.3/§5.2.6–5.2.10/§5.2.13–18) fill in as their write surfaces harden.

> ¹⁴ **Care Plan / IPOC (M7) now LIVE (Track B, M7-T09, ADR-0030).** Built under
> `apps/web/src/modules/07-care-plan` against M7's generated client methods (the M7 read routes are
> enriched in `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered
> into the M1 shell via `carePlanScreens` (`main.tsx`). The Care Plan View renders problems
> (terminal→related→unrelated) | the selected problem's goals/interventions | a signers + next-review
> aside; §7.6 SUD redaction is SERVER-side (the response carries `redacted: true`), never a frontend
> hide. Nav visibility is gated by `care_plan.read` / `care_plan.read_summary`; the SERVER stays the
> only enforcement point. The draft editor / signing modal / IDG-review screens fill in as their write
> surfaces harden.

> ¹⁵ **Encounters & Visit Notes (M8) now LIVE (Track B, M8-T12, ADR-0030).** Built under
> `apps/web/src/modules/08-encounters` against M8's generated client methods (the M8 read routes are
> enriched in `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered
> into the M1 shell via `encounterScreens` (`main.tsx`). The Encounter Read view renders the assembled,
> §7.6 SUD-redacted encounter + its cosignature state; the Cosignature Queue shows SLA chips derived from
> hours-since-primary-sign (green ≤12h → red >48h, §5.5); My Drafts lists the author's open drafts. Nav
> visibility is gated by `encounter.read` / `encounter.cosign` / `encounter.author`; the SERVER stays the
> only enforcement point. The authoring (§5.2), finalize/Layer-2 review (§5.3), and sign (§5.4) write
> surfaces — and the Socket.IO real-time preview channel (via M36, §4.3) — fill in as their write paths
> harden.

> ¹⁶ **Clinical Assessments Suite (M9) now LIVE (Track B, M9-T07, ADR-0030).** Built under
> `apps/web/src/modules/09-assessments` against M9's generated client methods (the M9 read routes are
> enriched in `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered
> into the M1 shell via `assessmentScreens` (`main.tsx`). The Assessment Timeline lists every captured
> scale (cosign-pending rows italic; SUD rows surface only as a 🔒 + server `redacted: true`, never a
> frontend hide, §7.6); the Per-scale Trend shows the 90-day scored series with significant-change
> markers; the per-patient Significant-change Inbox reads `significant_change_event` rows directly so the
> alert shows even when M36 push is degraded (§5.6); the Assessment Summary renders latest-per-scale
> cards; the org-admin Scale-license Registry + Scale-policy Editor surface license status / enabled
> state. Nav visibility is gated by `assessment.read` / `assessment.read_trend` / `assessment.read_summary`
> / `assessment.license_read` / `assessment.policy_read`; the SERVER stays the only enforcement point. The
> record-assessment modal (all 14 scales) and the ack/renew/policy write surfaces (§5.2) fill in as their
> write paths harden.

> ¹⁷ **HOPE Engine (M10) now LIVE (Track B, M10-T08, ADR-0030).** Built under
> `apps/web/src/modules/10-hope` against M10's generated client methods (the M10 read routes are enriched in
> `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell
> via `hopeScreens` (`main.tsx`). The Timepoint Dashboard buckets open schedules into Open / Closing-48h /
> Late / Expired counters (window state is a client UX cue; the SERVER owns the authoritative status); the
> Patient HOPE Timeline renders the Admission → HUV1 → HUV2 → SFV(s) → Discharge chronology with the
> server-authoritative J2051 max-severity + trigger chip (superseded rows struck through); the SFV Worklist
> sorts by the 2-calendar-day deadline (ADR-0018 D1); the Assessment Detail shows the PPS/ESAS-r snapshot +
> on-demand validation findings; the Submission Worklist + Detail surface per-PE batch outcomes; the HQRP
> Compliance Dashboard shows the on-time / SFV on-time / acceptance / late-completion KPIs. Nav visibility is
> gated by `hope.schedule.read` / `hope.timepoint.read` / `hope.sfv.read` / `hope.submission.read` /
> `hope.dashboard.read`; the SERVER stays the only enforcement point. The recording modal (all five RFAs),
> the late-completion confirmation dialog, the correction flow, and the schedule-admin write surfaces fill in
> as their write paths harden.

> ¹⁸ **Orders (M11) now LIVE (Track B, M11-T08, ADR-0030).** Built under
> `apps/web/src/modules/11-orders` against M11's generated client methods (the M11 read routes are enriched in
> `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell
> via `orderScreens` (`main.tsx`). The Signature Inbox is the global queue of orders awaiting signature, KPI'd
> by kind with a priority cue (the SERVER owns the authoritative §2.2 D2 status); the Patient Orders list
> ("Use Patient Workspace") renders every order for the patient with its lifecycle status and verbal deadline;
> the Order Detail shows signatures, the verbal deadline, the correction link, and the lab transmission /
> results lifecycle (D17); the Verbal-Expiring queue renders the 48h countdown with 12h/2h pre-expiry colour
> tiers (42 CFR 418.104(b) / D3); the Cosign-Pending queue surfaces LPN-drafted orders awaiting RN/supervisor
> cosignature (§2.5); the Lab Results-Pending-Review queue surfaces results received awaiting "Mark reviewed"
> (D17); the Standing-Order admin lists templates with cadence + spawn history (§2.4 D5). Nav visibility is
> gated by `orders.read`; the SERVER stays the only enforcement point (out-of-scope orders 404, never 403).
> The draft modal (all 8 kinds), the sign step-up, the record-verbal / cosign / discontinue / mark-reviewed /
> correct write surfaces, the standing-order admin writes, and the verbal-policy admin fill in as their write
> paths harden.

> ¹⁹ **DoseSpot Prescribing (M12) now LIVE — prescribing surfaces (Track B, M12-T09, ADR-0030).** Built under
> `apps/web/src/modules/12-dosespot` against M12's generated client methods (the M12 read routes are enriched in
> `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell via
> `dosespotScreens` (`main.tsx`). The Patient Medications list ("Use Patient Workspace") renders the active
> medications (status filter for drafts/history) with the controlled-substance posture; the Medication Detail
> shows the drug/sig facts, the §2.2 D2 lifecycle, the EPCS posture, signatures, refills, the correction
> lineage, and (for transmitted orders) the DoseSpot transmission/retry status; the Medication Sign Inbox is the
> prescriber's pending_signature queue KPI'd by controlled-vs-standard; the Verbal Medication Orders queue lists
> verbal_pending orders; the Refill Inbox sorts by SLA age (the `refill_inbox_scope` ABAC narrows server-side)
> with a Refill Detail; the Medication Reconciliation worksheet lists the DoseSpot MedHx; the Prescriber Roster
> admin shows DEA schedules + IAL2 status; the Prescribing Policy admin shows the refill SLA + controlled-
> substance refill caps + EPCS certification status. Nav visibility is gated by `prescribing.read` /
> `prescribing.history.read` / `prescribing.admin.roster` / `prescribing.admin.policy`; the SERVER stays the
> only enforcement point (out-of-scope resources 404, never 403; SUD-treatment meds redacted server-side). The
> prescribe modal (the native per-class authoring UI), the sign / sign-controlled EPCS step-up
> (`dosespot.epcs` OFF in Phase 1), the verbal / cosign / discontinue / correct / refill-decide / reconcile /
> roster / policy write surfaces, and the platform-ops EPCS-certification + webhook-explorer screens (apps/admin)
> fill in as their write paths / flags harden. The M13 administration (eMAR) screens land with M13.

> ²⁰ **eMAR Administration (M13) now LIVE — administration surfaces (Track B, M13-T10, ADR-0030).** Built under
> `apps/web/src/modules/13-emar` against M13's generated client methods (the M13 read routes are enriched in
> `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell via
> `emarScreens` (`main.tsx`). The Patient eMAR ("Use Patient Workspace + MAR Grid") renders the next-window
> scheduled-dose timeline alongside the patient's administrations (committed / pending-caregiver-review /
> superseded / voided) with the §2.5 late-entry tier + controlled posture; the Administration Detail shows the
> lifecycle, the witness pair, and the §2.9 BCMA match within the retention-class-C audit boundary; the IV
> Continuous Session lists the start→titrate→stop segment sequence; the patient Missed-Dose inbox queues
> unacknowledged misses; the Reconciliation Worksheet lists the per-line sources + decisions; the Comfort Kit
> view shows the deployment + disposal status; the Administration Policy admin shows the grace window + PRN
> reassessment defaults. Nav visibility is gated by `administration.read` / `administration.read_missed` /
> `reconciliation.read` / `comfort_kit.read` / `administration.admin.policy`; the SERVER stays the only
> enforcement point (out-of-scope resources 404, never 403; SUD-flagged administrations redacted/skipped
> server-side per §7.2). The Single-Dose / PRN / Witness administration modals, the IV titrate/stop, the
> missed-dose acknowledge, the reconciliation decide/finalize, the comfort-kit acknowledge-return write
> surfaces, and the offline/sync-issues mobile queue fill in as their write paths harden. The M22 eMAR PDF
> (apps/admin) and the M28 FHIR `MedicationAdministration` projection are deferred (Wave F/H forward deny-stubs).

> ²¹ **IDG (M14) now LIVE — read surfaces (Track B, M14-T07, ADR-0030).** Built under
> `apps/web/src/modules/14-idg` against M14's generated client methods (the M14 read routes are enriched in
> `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell via
> `idgScreens` (`main.tsx`). The IDG Schedule ("Use Work Queue + Documentation Workspace") lists the next-8-weeks
> meetings for a location (from `?location=`) with their lifecycle chip; the Meeting Detail shows the lifecycle +
> packet-readiness list; the Live Meeting Surface lists the meeting's patient packets over the lifecycle state;
> the Per-Patient Packet (chart embed) shows one patient's packet digest + freeze state; My Action Items queues
> the caller's IDG action items (`assignee=me` server-resolved) with overdue + linked-artifact markers; the
> Minutes view shows the finalized/in-progress minutes. Nav visibility is gated by `idg.read`; the SERVER stays
> the only enforcement point (out-of-scope resources 404, never 403; SUD-flagged packet blocks redacted at the
> SQL-filter level server-side per §7.2/W-SUD-01). The decision-recording panel (quorum gauge + non-quorate
> refusal), attendance tracker, action-item assignment, adjourn control (D13 fresh step-up), build-packets, and
> the minutes amendment-request write surfaces — plus the Socket.IO real-time propagation and the Capacitor
> Mobile Live variant — fill in as their write paths harden. The M22 minutes/packet PDF render and the M28 FHIR
> `CareTeam`/`Encounter` projection are deferred (Wave F/H handshakes).

> ²² **Scheduling (M17) now LIVE — read surfaces (Track B, M17-T08, ADR-0030).** Built under
> `apps/web/src/modules/17-scheduling` against M17's generated client methods (the M17 read routes are enriched
> in `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell
> via `schedulingScreens` (`main.tsx`). The Day View / Week View ("Use Work Queue") list a clinician's visits for
> a service date / week with the §2.2.1 lifecycle chip; the Proposal Inbox lists pending frequency/order/IDG/
> supervisory proposals; the Recurring Policies view lists a patient's active recurring-visit policies + RRULE;
> the Time-Off Queue is the supervisor PTO approval queue; the Visit Detail ("Use Detail Page") shows one visit's
> status + scheduled window + assignment + reschedule chain; My Visits is the clinician's own today + upcoming-7-
> days queue; Scheduling Metrics ("Use Dashboard") shows the org-wide on-time / no-show / reschedule rates. Nav
> visibility is gated by the matching M17 permission key (`visit.read_team` / `visit.proposal.read` /
> `recurring_visit.read` / `time_off.read_team` / `visit.read` / `visit.read_metrics`); the SERVER stays the only
> enforcement point (out-of-scope visits 404, never 403; the §4.7 pre-schedule ABAC + RLS narrow every read). The
> drag-drop reschedule, publish-all, create/discontinue-recurring, approve/deny-time-off, availability editor, and
> the OSRM map (polyline) write/visual surfaces — plus the Capacitor mobile Today/Map variants and the M31 portal
> upcoming-visit view — fill in as those write paths / Phase-2 modules land (`scheduling.route_optimization` OFF).

> ²³ **EVV (M18) now LIVE — read surfaces (Track B, M18-T07, ADR-0030).** Built under
> `apps/web/src/modules/18-evv` against M18's generated client methods (the M18 read routes are enriched in
> `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell via
> `evvScreens` (`main.tsx`). The EVV Dashboard + EVV Metrics ("Use Dashboard") show the org-wide compliant /
> late-checkout / geofence-deviation / GPS-spoof / aggregator-acceptance rates; the Event Ledger ("Use Work
> Queue") is the coordinate-free, caseload-scoped capture ledger and the Event Detail ("Use Detail Page") shows
> one event's raw + computed fields; the Missing-EVV Resolutions queue is the §2.2.4 D6 late-checkout backlog;
> the Aggregator Submissions queue is the §2.2.5 D7 per-state submission backlog; the Geofence Policy view shows
> the tenant tighten-only default + per-address overrides; the Devices roster surfaces pending-approval devices
> first; My Devices is the clinician self-service list. Coordinates are NEVER projected by these read paths (D10
> — `evv.read_coords` is a separate permission/path). Nav visibility is gated by the matching M18 permission key
> (`evv.read_metrics` / `evv.read` / `evv.missing_resolution.read` / `evv.aggregator.read` / `evv.policy.read` /
> `evv.device.read`); the SERVER stays the only enforcement point (out-of-scope events 404, never 403; the §4.7
> capture ABAC + RLS narrow every read). The mobile check-in/check-out capture flow (§5.2, owned by the M17
> visit-detail CTA), the resolution-attest / device-approve / policy-edit / aggregator-resubmit write surfaces,
> and the M31 portal arrival view fill in as those write / Phase-2 paths land.

> ²⁴ **Document Management (M22) now LIVE — read surfaces (Track B, M22-T10, ADR-0030).** Built under
> `apps/web/src/modules/22-documents` against M22's generated client methods (the M22 read routes are enriched
> in `scripts/openapi/enrichments.ts`, so `packages/ui/src/core/api` types them), registered into the M1 shell
> via `documentScreens` (`main.tsx`). Built to the **Lantern** design language (`docs/design/DESIGN.md`) — the
> first module screens authored against the unified `@theme` tokens (`var(--color-*)` / `var(--radius-*)` /
> `var(--shadow-soft)` / `var(--font-*)`): warm-paper surfaces, the §6.6 status-pill taxonomy (color always
> paired with a glyph, Hard Rule §10.10), §6.2 Lantern Cards, §3.1 mono identifiers, No-Line tables (§6.7) —
> rather than the older inline-hex styling. DOC.Explorer ("Use Work Queue") is the tenant-wide document browse +
> retention-class filter, KPI'd by total / Part 2 / from-intake; DOC.VersionHistory ("Use Detail Page") renders
> the per-document version chain with the current-version aside; INTAKE.BatchDetail ("Use Detail Page") shows the
> batch pipeline status + the per-job extraction lifecycle (DocLens jobs queue as `awaiting_capability` while
> M32 is off — an in-progress pill, never a hard error); FORM.TemplateLibrary ("Use Work Queue") browses the
> platform-floor templates. Nav visibility is gated by `documents.read` / `documents.read_history` /
> `intake.read` / `documents.read_templates`; the SERVER stays the only enforcement point (out-of-scope rows are
> non-leaking 404s, SUD content + legal-hold blocks are server-side, never a frontend hide). The upload dialog /
> tag editor / signed-URL preview / DocLens side-by-side review (INTAKE.ReviewSideBySide) / overlay editor write
> + modal surfaces fill in as those write paths harden; the mobile §5.2 + portal §5.3 (M31 Phase-2) surfaces are
> forward-seams.

---

## Blocked on later waves (out of Track A scope until their module lands)

These screens (clinical suite, revenue, portal, platform/ops) are owned by modules across the remaining
waves (M7–M37). They are **Track B**: each ships with its module's wave (include the
`apps/web/src/modules/NN-*` codePath from T01; the terminal screen task builds it). The `done` items below
shipped in-wave; the generated **ui-parity matrix** (`audit/ui-parity/UI_PARITY.md`) is the authoritative
per-screen status. Examples:
Care Plan (M7 done; M15 discipline plans + volunteer management done²⁴), Orders (M11; done¹⁸),
eMAR administration (M13; done²⁰; M12 prescribing is done¹⁹),
IDG (M14; done²¹), Bereavement (M16; done²⁵), Scheduling (M17; done²²), EVV (M18; done²³),
Supplies/DME/Comfort Kits (M21; done²⁶), Claims (M23; done), Medicaid (M24; done),
Remittance & Denials (M25; done), Cap (M26; done), Cost Report (M27), FHIR (M28), HQRP (M30),
Portal/Telehealth (M31), Copilot (M32), Reporting (M33; done), Onboarding (M34; done),
Subscription (M35), IPU Bed Board (M37). See each spec's `Module:` line for the authoritative owner.

> ²⁴ **M15 Discipline Care Plans + Volunteer Management now LIVE (Wave P2-1, M15-T07).** Twelve screens under
> `apps/web/src/modules/15-discipline-care-plans`, registered into the M1 shell via `disciplinePlanScreens`
> (`main.tsx`) and reached from a new "Discipline Plans" item on the patient-chart module rail. They cover
> the M15 §5.1 inventory: the four-plan index; the Aide POC view with the 42 CFR §418.76(h) next-due ladder,
> the RN supervisory-attestation ledger and its capture/sign modals; the Aide POC task/goal editor; the MSW,
> Spiritual and Volunteer plan views (the last with the gate-checked assignment ceremony); the discipline
> assessment capture/sign/amend surface; the version chain with its sealed snapshot + signed-version diff;
> the post-IDG revision review; the printable summary; and — under "Admin", the two tenant-wide 418.78
> surfaces — the volunteer compliance-gate manager and the 5% time-cost ratio dashboard. Built to Lantern:
> the §6.6 StatusPill taxonomy through a per-module `discipline-status.ts`, No-Line tables (§6.7), CSS-var
> tokens only (zero hex). The §5.1 modals are not separate registry entries — each lives in the parent screen
> that already read the row `version` its `If-Match` needs. Nav visibility is gated by the real §4.4 keys
> (`discipline_plan.read` / `.author` / `.read_summary` / `.idg_revise`, `discipline_assessment.author`,
> `volunteer_compliance.read` / `.read_ratio`); the SERVER stays the only enforcement point — an off-caseload
> plan is a non-leaking 404 and the §7.8/§7.9 SUD + family-violence filtering happens in SQL, surfaced to the
> user as the response's `redacted_categories` marker rather than as a silent omission. Honest gaps, stated
> on the screens themselves rather than faked: the 5% ratio renders "cost basis unavailable" while the M27
> patient-care-hours denominator is unbound (never a 0% breach); the assessment `data` payload is entered as
> JSON because the §3.4 per-kind TypeBox schemas are not published to the client; the aide/supervising-RN
> binding is read-only because M15 publishes no route that re-points it; and the §5.2 mobile + §5.3 portal
> variants remain forward-seams.

> ²⁵ **M16 Bereavement now LIVE (Wave P2-1, M16-T07).** Eleven screens under
> `apps/web/src/modules/16-bereavement`, registered into the M1 shell via `bereavementScreens` (`main.tsx`)
> under a new "Bereavement" nav group, over the live 33-route M16 backend. They cover the M16 §5.1
> inventory: the counselor caseload dashboard (with the 30/14/7-day anniversary banner as a polite live
> region); the supervisor program dashboard; the intake queue with the counselor + volunteer assignment
> ceremonies; the plan detail with the D18 first-contact gate; the roster + D4 schedule seeding flow; the
> bereaved-contact detail with the opt-out / rescind / deceased / unreachable / confirm ceremonies; the
> outreach planner with the start / complete / decline / no-response / cancel / late-attempt transitions;
> the D3+D17 risk ledger with its recompute + override ceremony; the PG-13 complicated-grief screen with
> the escalation and referral composers; the 13-month closeout; and the §7.15 survey-reconstruction
> history. Built to Lantern: the §6.6 StatusPill taxonomy through a per-module `bereavement-status.ts`,
> No-Line tables (§6.7), CSS-var tokens only (zero hex). §5.1 modals are not separate registry entries —
> each lives in the parent that already read the row `version` its `If-Match` needs. Nav visibility is
> gated by the real §4.7 keys (`bereavement.dashboard.counselor` / `.supervisor`, `bereavement.plan.read` /
> `.assign_counselor` / `.activate`, `bereavement.outreach.read`, `bereavement.risk.read`,
> `bereavement.contact.flag_complicated_grief`); the SERVER stays the only enforcement point — an
> off-caseload plan is a non-leaking **404**, deliberately, because "this plan 403s" would tell an
> unauthorized caller that a particular patient died.
>
> Two route-shape departures from §5.1, both because architecture wins over the screen spec: the
> bereaved-contact detail and the grief screen are **plan-scoped** (`/bereavement/plans/:planId/contacts/…`)
> because M16 publishes no "get one contact" read — a survivor is only ever returned inside their plan,
> which is what makes the §7.13 redaction and the D10 volunteer scope ONE decision on ONE body; and paths
> are mounted at the root rather than under `/app`, per the M15/M17/M18 shell convention.
>
> Honest gaps, stated on the screens themselves rather than faked: §5.1 #9's drag-to-reschedule is not
> built because M16 publishes no per-touchpoint date PATCH — the planner offers route 27's forward
> regeneration, which is what the server actually has; §5.1 #5's live `volunteer_gates_satisfied` badge is
> not pre-rendered because no route reads one volunteer's 418.78 status, so the assignment attempt's
> refusal is the real gate answer; §5.1 #18's "transition to `closed_completed`" is not a button, because
> §2.2 makes the 13-month completion a cron cascade and the four system-driven closure reasons are
> excluded from `CloseEarlyBody` — a button there would have had to misuse the early-close path and record
> a curtailed obligation as a fulfilled one; the §5.1 #19 history is reconstructed from the plan's own
> rows and says so, since the immutable audit trail (refused reads, break-glass, cascade actors) belongs
> to the M4 surface that owns it; the M40 external grief-resource picker takes an id rather than browsing
> a catalog M16 does not publish; and the §5.2 mobile + §5.3 portal variants remain forward-seams.

> ²⁶ **M21 Supplies, DME & Comfort Kits now LIVE (Wave P2-1, M21-T06).** Ten screens under
> `apps/web/src/modules/21-supplies`, registered into the M1 shell via `supplyScreens` (`main.tsx`) under a
> new "Supplies" nav group, over the live 37-route M21 backend. They cover the M21 §5.1 inventory: the
> supply-team dashboard (which is also the index for requests, dispatches and returns, since §4.1 publishes
> no separate list screens); the supply-request detail driving the §2.2 fulfillment machine with the frozen
> D4 routing trace; comfort-kit dispatch creation and detail; the §2.6 return reconciliation with its
> witnessed-disposal and write-off ceremonies; and the four agency-operations surfaces — par stock, vendor
> routing, comfort-kit templates and the D11 SKU catalog. Built to Lantern: the §6.6 StatusPill taxonomy
> through a per-module `supplies-status.ts` keyed on the frozen pgEnum lists, No-Line tables (§6.7), CSS-var
> tokens only (zero hex). §5's ceremonies are not separate registry entries — each lives in the parent that
> already read the row's `updated_at`, which is M21's `If-Match` value (§7.2; M21's tables carry no version
> counter). Nav visibility is gated by the real §4.3 keys (`supplies.request.read`, `supplies.item.read`,
> `comfort_kit.dispatch.create` / `.read`, `comfort_kit.perpetual_log.read`, `comfort_kit.return.read`,
> `comfort_kit.template.read`, `vendor_routing.read`, `par_stock.read`); the SERVER stays the only
> enforcement point.
>
> **An eleventh screen that §5.1 does not list: the DEA 21 CFR §1304 perpetual log**
> (`/supplies/dispatches/:id/perpetual-log`). §4.3 gives it its own `compliance`-category key, disjoint from
> `comfort_kit.dispatch.read` — a coordinator who may dispatch must not thereby acquire the lot-level
> custody chain. Nav gating is per-screen, so folding it into the dispatch detail would have made the
> dispatch key the effective gate on the ledger, strictly wider than §4.3 says.
>
> Honest gaps and departures, stated on the screens themselves rather than faked: the §5.2 KPI tiles are
> PAGE-derived (M21 publishes no aggregate route and no `total_count`), so a truncated page carries an
> explicit "at least" notice; §5.2's "in-transit late" and "undeliverable" tiles are not built, because
> `supply_request` has no expected-delivery column and the status enum has no undeliverable value; §5.4's
> patient autocomplete is replaced by an open-kit-request picker, since the dispatch body has no patient
> field (patient, admission and provider entity come from the request); §5.4's per-line witness picker and
> chain-of-custody scan list are not built, because the dispatch stores neither — the witness is a §2.6
> *disposal* fact and only for at-home destruction; §5.7's threshold editor edits the real columns
> (`reorder_point` / `reorder_quantity` / `min_safety_stock`, not the sketch's par_min/par_target) and its
> photo capture is dropped for want of a document column; §5.8's fallback-chain column and "simulate
> routing" panel are not built, because §3.0 REMOVED the fallback model and simulating client-side would put
> a second copy of the resolver in the browser — the frozen `routingRuleResolved` trace on each request is
> the real answer; §5.9's RxNorm autocomplete is free text (M21 publishes no terminology lookup and M38's is
> another module's screen); §5.10's tenant-extension drawer is dropped because the overlay rows are already
> first-class list entries; §5.3's M4 audit drawer is not built — the audit trail belongs to the M4 surface
> and its own permission, so the lifecycle timeline is reconstructed from the request's own columns and says
> so; and the §5.11 mobile variants (courier delivery, clinician confirm, kit-return witness) remain
> forward-seams — the first two are the same routes the request detail's action panel already drives, and
> the third has no route at all, since witness co-attestation is a field inside `reconcile` rather than its
> own transition.
>
> **`discrepancy_pct` and `replenishment_threshold_pct` are FRACTIONS in [0,1], not percentages** — the D8
> trigger compares against `0.05` and §3.1.4's CHECK bounds the threshold to [0,1] — and they reach the wire
> raw. The web slice converts in exactly one place (`fractionAsPct`); the §9.3 live RLS suite asserts the
> scale, because printing 0.05 under a "%" heading would understate a controlled-substance shortfall a
> hundredfold.

---

## How to use this ledger

- **Track A** (dedicated backlog wave): pick the next `deferred` row above, add the module's
  `apps/web/src/modules/NN-slug` codePath to the manifest (+`.cjs`), `bun run scaffold`, build the
  screen against the generated client + the layout component, register it into the M1 shell, set the
  row `done`.
- **Track B** (per-module, going forward): when a blocked module is built, its screen ships in-wave;
  mark its row `done` here so Track A never double-builds it.
