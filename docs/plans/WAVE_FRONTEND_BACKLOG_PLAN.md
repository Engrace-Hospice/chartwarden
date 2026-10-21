# ChartWarden — Frontend Backlog Wave (Track A · Archon task plan)

The **Track A** dedicated backlog wave from
[`FRONTEND_INTEGRATION_PLAN.md`](./FRONTEND_INTEGRATION_PLAN.md) §"Track A", made executable as an
ordered `chartwarden-piv` task ladder. It runs as its own wave (`feat/frontend-backlog` worktree, same
archon/`/loop` + gate machinery). **Conventions, determinism rules, the validate gate, and the legend
are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`** — read its header first. The gate is the same:
`bun run build && bun run arch:fitness && bun run test` all green (lint is separate CI, pre-existing-red).

> **Governing ADRs:** [ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md) (each module owns
> `apps/web/src/modules/NN-*`, registered into the M1 shell — never imported by the shell),
> [ADR-0032](../adr/ADR-0032-frontend-api-transport-and-client.md) (OpenAPI → generated typed client in
> `packages/ui/src/api`; no `apps/web`→`apps/backend` edge). Status ledger:
> [`docs/design/DEFERRED_SCREENS.md`](../design/DEFERRED_SCREENS.md) (mark rows as tasks clear).

## Why this wave exists (read first — it refines Track A's original scope)

F0 + the first interactive Track A pass built the **11 "Ready now" screens** and marked them `done`. But
a follow-on audit found the screens for **M36 / M38 / M39 / M40 are frontend-only**: the React slices
exist, but their **backend routes are not mounted** in the composition root
(`apps/backend/src/index.ts`) and their seams are still **in-memory slices / deny-stubs** — so those
screens call endpoints that 404. This wave makes the merged-module screens **real end-to-end**, then
fills the **M5 Patient Chart's own tabs** and the **unblockable partials**, and clears the **M2 auth
backend follow-ups**.

This is still Track A's invariant set (additive read-layer; no new `dependsOn` edges; backend-first):
the route **mount** lines live in M1's composition root (M-agnostic infra, already its job); each
module's *routes/* and *seams* files already exist and are owned by that module's `codePaths`. No
manifest `codePaths` change is required — the `apps/web/src/modules/NN-*` slices and the
`apps/backend/.../routes` files are already on `main`.

### Standing obligations every task honors

1. **Backend-first within the task.** Mount/​wire the backend, regenerate the contract, *then* verify
   the screen against it. A screen task that adds or mounts a route runs `bun run openapi:emit` (else
   `openapi:check` fails) **and** `bun run client:gen` (regenerate `packages/ui/src/api`), committing
   both. Non-trivial bodies get an `enrichments.ts` entry (F0-T01).
2. **No new authz on the frontend.** Screens reuse the server's permission keys via the client; the
   server stays the only enforcement point. PHI reads stay RLS-scoped by the ambient request context.
3. **Drizzle stores are RLS-correct.** New stores read/write under `chartwarden_app` (not the superuser),
   scoped by the request's org/session context — mirror the M2/M3/M4/M5 live stores
   (`membership-repository.ts`, `role-store.ts`, `patient-route-service-db.ts`). Where cross-tenant
   isolation matters, extend `rls-isolation.live.test.ts` (CI `rls-live`).
4. **Ledger is the coordination point.** Each task flips its `DEFERRED_SCREENS.md` row(s)/notes; Track B
   skips anything marked `done`.

> **Landed early (local bring-up, 2026-06-22).** Standing up the app locally surfaced that **M2
> org-select was a no-op end-to-end**: `mountIdentityRoutes` wired `sessions:` to the in-memory
> `createInMemorySessionWriter` (which the auth layer never reads), and the route actor resolver used
> the Fastify `request.id` as the session id. Fixed under FB-T16 below: `session-writer-db.ts` persists
> `session.active_organization_id`, and `authenticate` threads the real Better-Auth session id through
> `request.context.attributes.sessionId`. With it, sign-in → select-org → org-scoped routes
> (roles/members/patients/audit) all return 200. Local runtime is also scripted now
> (`bun run db:up && db:migrate && db:seed [&& db:seed:patients]`, `dev:backend`/`dev:web`).

---

## Group 1 — Live-wire merged-module backends (the screens already exist; make them real)

Order: M38 → M40 → M39 → M36 (ascending blast radius; M36 messaging is heaviest and gates the
magic-link follow-up). Each task = mount routes in the composition root + back the seam with a Drizzle
store + regenerate the client + verify the existing screen now reads live data.

### FB-T01 — Mount M38 Terminology + Drizzle store
- deps: none · files: `apps/backend/src/index.ts`, `apps/backend/src/modules/38-terminology/*`,
  `packages/ui/src/api` · backend: `apps/backend/src/modules/38-terminology/routes/terminology-routes.ts`,
  `.../seams.ts` (`TerminologyProvider`)
- do: implement a Drizzle-backed `TerminologyStore` (over the `code_system` / `value_set` /
  `value_set_member` / `value_set_tenant_extension` tables) and inject it into the
  `TerminologyProvider` seam at the composition root; call `registerTerminologyRoutes(app, …)` from
  `registerModuleRoutes`. `openapi:emit` + `client:gen`. Verify `apps/web/src/modules/38-terminology`
  reads live (validate/lookup/expand + tenant value-set extensions).
- accept: gate green; M38 routes mounted; terminology-admin screen hits live endpoints; ledger note
  updated (M38 row "live").

### FB-T02 — Mount M40 MDM + Drizzle MdmStore/BaaStore
- deps: none · files: `apps/backend/src/index.ts`, `apps/backend/src/modules/40-mdm/*`,
  `packages/ui/src/api` · backend: `.../routes/mdm-routes.ts`, `.../seams.ts`
  (`MdmEntityProvider`, `BaaStatusProvider`)
- do: Drizzle-backed `MdmStore` (canonical entities + overlays + `merge_request`) and `BaaStore`
  (§7.7 as-of) injected into both seams; mount `registerMdmRoutes`. `openapi:emit` + `client:gen`.
  Verify `apps/web/src/modules/40-mdm` (entity directory + merge console + NPPES lookup) reads live.
- accept: gate green; M40 routes mounted; mdm-console live; ledger updated.

### FB-T03 — Mount M39 Consent + Drizzle ConsentStore
- deps: none · files: `apps/backend/src/index.ts`, `apps/backend/src/modules/39-consent/*`,
  `packages/ui/src/api` · backend: `.../routes/consent-routes.ts`, `.../seams.ts` (`ConsentEvaluator`)
- do: Drizzle-backed `ConsentStore` (append-only `consent_record` + supersession + per-recipient /
  per-DPOA joins) injected into the `ConsentEvaluator` seam; mount `registerConsentRoutes`. This also
  makes the **Patient Chart consent tab** (FB-T10) a real data source. `openapi:emit` + `client:gen`.
- accept: gate green; M39 routes mounted; `GET /api/v1/patients/:id/consents` returns live records;
  the `consent` eraser still refuses §3.8; ledger updated.

### FB-T04 — Mount M36 Messaging read paths
- deps: none · files: `apps/backend/src/index.ts`, `apps/backend/src/modules/36-messaging/*`,
  `packages/ui/src/api` · backend: `.../routes/messaging-routes.ts`, `.../seams.ts`
- do: back the `MessagingRouteService` reads (channel list, message thread reads, alert/notification
  inbox) with Drizzle and mount `registerMessagingRoutes` + `registerMessagingAbacPredicates`. Send/
  receipts/encryption (write path) stay deny-stubbed → FB-T05. `openapi:emit` + `client:gen`. Verify
  `apps/web/src/modules/36-messaging` (staff-messaging + notifications-inbox) renders live reads.
- accept: gate green; M36 read routes mounted; channel/notification lists live; write actions degrade
  gracefully (clear "coming in FB-T05" state, not a hard error); ledger updated.

### FB-T05 — M36 MessagingProvider real impl (write path · §4.x T07/T08)
- deps: FB-T04 · files: `apps/backend/src/modules/36-messaging/*`, `packages/messaging/src/*`
- do: implement the real `MessagingProvider` seam (replace the boot deny-stub): DB-backed message
  send/edit/delete + read receipts + per-channel DEK message encryption (M1 KEK/DEK helper), over the
  T04 fan-out engine already in `packages/messaging`. Wire `channel_visibility` ABAC. Extend
  `rls-isolation.live.test.ts` for two-tenant channel isolation.
- accept: gate green incl `rls-live`; `validateSeams()` sees a real `MessagingProvider` (no deny-stub);
  staff-messaging send/read-receipt works end-to-end; ledger M36 rows → `done`.

---

## Group 2 — M5 Patient Chart tabs (frame is `done`; fill the M5-owned tabs)

Each tab is an M5-owned section of `apps/web/src/modules/05-patient/patient-chart.tsx` (the
`NAV_SECTIONS` array), built against M5's generated client methods. Add the backend GET route where
one doesn't exist yet (then `openapi:emit` + `client:gen`). Cross-module tabs (encounters, orders,
eMAR, …) stay Track B.

### FB-T06 — Demographics & Identifiers tab
- deps: none (M5 reads live) · spec: `docs/design/screens/clinical/CHARTWARDEN_UI_PATIENT_CHART.md`
- do: real Demographics tab — names/aliases, DOB, SOGI/race/ethnicity/language (M38 value-set labels),
  identifiers with **gated SSN/state-ID** (masked; step-up to reveal — reuse `/step-up`), MRN immutable.
  Add `GET /api/v1/patients/:id/identifiers` + `/demographics` if not covered by the existing detail.
- accept: gate green; tab renders live M5 data; protected ids masked w/o step-up; ledger note (#4).

### FB-T07 — Addresses tab (append-only, primary rotation)
- deps: none · do: list addresses via the existing `GET /api/v1/patients/:id/addresses`; add-address +
  atomic primary rotation via the live M5 write path (`addAddress`, M5 D5 append-only with
  `effective_from/effective_to`). geocode badge if present.
- accept: gate green; add/rotate works against live writes; ledger note.

### FB-T08 — Coverage / Payers tab
- deps: FB-T02 (M40 Payer resolution live) · do: render `patient_payer` rows resolving M40 `Payer`
  display names via the MDM client; primary-payer badge. Add `GET /api/v1/patients/:id/payers` +
  `openapi:emit`/`client:gen`.
- accept: gate green; payers render with resolved M40 names; ledger note.

### FB-T09 — Care Team & Assignments tab
- deps: none · do: render `patient_assignment` (member roster via M2/M3 client) + `patient_caregiver` /
  `emergency_contact` + primary caregiver / legal rep. Add `GET /api/v1/patients/:id/care-team` (or
  compose existing) + regenerate client.
- accept: gate green; care-team renders live; ledger note.

### FB-T10 — Privacy Flags tab (consent-gated)
- deps: FB-T03 (M39 consent mounted) · do: render `patient_privacy_flag_snapshot` badges + the consent
  surface (the M39 "consent inside Patient Chart" tab, ledger §"M39 — no standalone screen") from
  `GET /api/v1/patients/:id/consents`. SUD/Part-2 sections fail-closed when not disclosable.
- accept: gate green; flags + consents render; redaction fail-closed; ledger M39 note → covered by #4.

---

## Group 3 — Unblockable partial screens

### FB-T11 — Global Search Results (M5 + M2 facets only)
- deps: FB-T01..T05 · spec: `docs/design/screens/core/CHARTWARDEN_UI_GLOBAL_SEARCH_RESULTS.md`
- do: build the Global Search frame + the **patient facet** (`GET /api/v1/patients?q=`) and **staff
  facet** (`GET /api/v1/orgs/:id/members?q=`). Later facets (orders/docs/visits) render as labeled
  "available when <module> ships" rows — visible, not fabricated. Register into the shell top-nav search.
- accept: gate green; patient + staff facets return live results; ledger row → `done (partial — M5+M2
  facets)`.

### FB-T12 — Staff Management enrichment (what M2 exposes today)
- deps: none · do: add the columns/KPIs that the **current M2 surface** supports (name/email,
  last-login, pending-invite/locked KPIs) to `apps/web/src/modules/02-identity/staff-management.tsx`;
  add the backing fields to the member roster route if missing (`openapi:emit`/`client:gen`).
  Discipline/credentials stay deferred to **M34** (note it, don't fake it).
- accept: gate green; enriched roster live; ledger Staff-Management partial note updated.

---

## Group 4 — M2 auth backend follow-ups

### FB-T13 — WebAuthn step-up ceremony
- deps: none · files: `apps/web/src/modules/02-identity/step-up.tsx`, `apps/backend/src/modules/02-identity/*`
- do: complete the browser WebAuthn step-up ceremony (assertion → server verify) alongside the existing
  TOTP path; paired-write `lastStepUpAt`/`lastStepUpFactor` that M3's `step_up_recent` gates on. Reuse
  the `passkey` client plugin's ceremony; build-/e2e-verified (browser-only, not CI-unit).
- accept: gate green (`build` + `arch:fitness` + `test`); TOTP path unchanged; ledger ¹-note updated
  (remove "WebAuthn step-up" from auth follow-ups).

### FB-T14 — Magic-link / password-reset email delivery via M36
- deps: FB-T04, FB-T05 · do: wire Better Auth `requestPasswordReset` / magic-link email delivery to the
  now-live M36 notification path (replace the dev-log delivery). No new frontend.
- accept: gate green; reset/magic-link emails dispatch through M36; ledger ¹-note updated.

### FB-T15 — M2↔M3 actor role/membership enrichment
- deps: none · do: enrich the session/actor context in the shell with the actor's roles/memberships
  (the M2↔M3 seam) so the Role Home / nav reflect real role-scoped tiles instead of the placeholder
  greeting. Read-only via the client; no new authz.
- accept: gate green; Role Home renders role-scoped; ledger App-Shell ³-note updated.

### FB-T16 — Live-wire the remaining in-memory M2 identity stores
- deps: none · files: `apps/backend/src/modules/02-identity/*`, `apps/backend/src/modules/02-identity/index.ts`
- status: **org-bind session writer DONE** (`session-writer-db.ts` + the `request.context.attributes.sessionId`
  thread in `authenticate.ts` / `identity-ports.ts` — landed during local bring-up; see the note above).
  Remaining `mountIdentityRoutes` deps are still in-memory and need Drizzle stores: **invitations**
  (`organization_invitation`), **collaborators** (per-patient magic-link, §7.6), **user directory**
  (deactivate/offboard §7.5), and the **audit sink** (route the identity audit through the real M4 `audit()`
  instead of the in-memory executor). Each replaces a `createInMemory*` slice with a `*-db.ts` store.
- accept: gate green; invite → accept → membership, offboard, and collaborator-link flows persist to the DB;
  identity mutations land in `audit_event`; the in-memory M2 slices remain only as the test default.

---

## Done when

All Group-1 module screens read **live** (routes mounted, seams Drizzle-backed, `validateSeams()`
deny-stub-free for `MessagingProvider`); the M5 Patient Chart's M5-owned tabs are real; Global Search
(M5+M2) and the enriched Staff roster ship; the three M2 auth follow-ups clear. `DEFERRED_SCREENS.md`
shows no `deferred` row whose blocker is a *merged* module. Remaining `deferred`/`partial` rows are all
genuinely blocked on unbuilt modules (M17, M34, later clinical/revenue/portal) → **Track B**.
