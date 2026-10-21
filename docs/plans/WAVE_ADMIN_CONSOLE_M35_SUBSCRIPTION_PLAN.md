# ChartWarden — Wave Admin-Console: M34 admin shell (bootstrap) · M35 Subscription-Billing §5.2 platform-ops screens

Builds the **§5.2 Platform-Ops Admin surface** for Module 35 (14 screens under `/admin/*`). The M35
backend admin routes already exist and are gated (shipped in M35-T06); this wave adds the **frontend
console** plus the two backend/auth prerequisites that make it reachable. **Conventions, determinism
rules, the validate gate, and the legend are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.**

Specs (`docs/modules/`): `CHARTWARDEN_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md` (§5.2), and M34's spec
for the admin-shell ownership. Design: `docs/design/screens/platform/CHARTWARDEN_UI_SUBSCRIPTION_BILLING.md`.

> **⚠ Ownership decision (resolve before running — this is the one human call).**
> `apps/admin` is assigned to **M34 (SaaS tenant-operator)** by **ADR-0030**, not M35. The admin console
> mirrors the `apps/web` model: **M34 owns the shell** (app root, `main.tsx`, router, screen-registry host)
> and each platform module contributes a **`apps/admin/src/modules/NN-*` slice** registered into that shell —
> exactly as M1 owns `apps/web` and feature modules own `apps/web/src/modules/NN-*`. This wave therefore
> spans **two modules**: M34 (Phase 0 shell + platform roles) and M35 (Phase 1 backend gaps + Phase 2 the
> 14-screen slice). **No ADR amendment is needed** — ADR-0030 already grants `apps/admin` to M34; this wave
> *materializes* it. The alternative (M35 owns all of `apps/admin`) contradicts ADR-0030 and would need an
> ADR change — not recommended.

> **Build order:** Phase 0 (M34 shell ∥ platform roles) → Phase 1 (M35 backend gaps) → Phase 2 (M35 screen slice).
> Deps: no new `dependsOn` edges. **M34↔M35 stays seam-both-ways, no edge either way (ADR-0025)** — the M35
> slice reads tenant identity via M2's `OrganizationReader` seam, never an M34 import. The slice imports only
> `@wardenx/ui` (generated client, ADR-0032), `@wardenx/types`, and the M34 admin-shell registry contract.

> **Backend/auth gaps this wave CLOSES (blocking until closed):**
> | Gap | Symptom today | Closed by |
> |---|---|---|
> | Platform-ops roles unregistered (`platform_billing_admin`, `platform_owner`, `platform_admin`, `platform_support_t2`, `platform_sales`, `platform_ops`) — exist only as a string array in M35 `abac-predicates.ts`, absent from `packages/auth/src/roles/templates.ts`; no catalog role grants the 17 `billing_admin.*` keys | `platform_billing_scope` ABAC denies **every** caller → whole §5.2 surface is 403 for all | **ADMIN-T02** |
> | `/admin/dunning` has no read route — only `POST …/skip_stage` + `…/reset` exist; `DunningDto` returned only by mutations | Dunning screen has nothing to render | **M35A-T03** |
> | No detail GETs (`/admin/plans/:id`, `/admin/refunds/:id`, `/admin/promos/:id`) | Edit/approve screens must hydrate from list rows | **M35A-T03** (add GETs) |
> | Cross-tenant list DTOs expose `organizationId` UUID but no org **name**; refund queue lacks invoice/customer context | Admin lists show raw UUIDs | **M35A-T03** (resolve via M2 `OrganizationReader` seam — no new edge) |
>
> Already in place (do NOT rebuild): the 27 admin routes + 17 permission keys (`M35_CONTRIBUTED_PERMISSIONS`),
> ABAC predicates (`platform_billing_scope`, `promo_applicable_to_subscription`,
> `refund_requires_step_up_approval`), **step-up** (`requireStepUp`/`step_up_recent`) and **four-eyes**
> (`REFUND_FOUR_EYES` 403 when approver == requester) on refund approval, idempotency guards, the fully
> **enriched typed client** (`packages/ui/src/core/api/schema.ts` — admin routes resolve to real DTOs, not
> `never`), and the read DTOs for subscriptions/refunds/revenue/promos/usage/webhooks.

> **Gate blind spot — `apps/admin` is invisible to `arch:ui-parity` + `arch:frame-fidelity`.** Both scan
> `apps/web/src/modules/*/screens.ts` ONLY. A new admin app is neither validated nor covered by them, and its
> screens are not registered into `apps/web/src/main.tsx` (so no "UNREGISTERED SCREENS" trip either). The
> **substitute** is a registry unit test under the normal `vitest` gate — mirror
> `apps/portal/__tests__/portal-screens.test.ts`: assert manifest↔component binding, correct `moduleId`/`slug`,
> unique ids + unique paths, well-formed `requiredPermission` **validated against the real `packages/auth`
> catalog** (the parity gate does this for `apps/web`; nothing will for `apps/admin`), and duplicate-registration throw.

> **Phase-3 flags stay OFF.** No live Stripe egress is required for §5.2 (the "Sync to Stripe" / webhook
> "Replay" CTAs invoke existing outbox-only routes; the vendor SDK does not mount in this surface).

---

## Phase 0 — Admin shell + platform roles (M34-owned prerequisites)

## Module 34 — SaaS Platform (deps: — · `apps/admin` [NEW shell codePath]) — 0 new tables
- **ADMIN-T01** Scaffold the `apps/admin` SPA shell. Add `apps/admin/src/shell` (+ app-root) to **M34** `codePaths` in `architecture/module-manifest.ts` **and** the `.cjs` mirror; `bun run scaffold` (regenerates root `tsconfig.json` references; `arch:parity` 1:1). Hand-author the shell mirroring `apps/portal`/`apps/web`: `apps/admin/{package.json (@wardenx/admin), tsconfig.json, vite.config.ts (unique dev port ≠ 5173/5174), index.html}`, `src/{main.tsx, app.tsx, index.css, index.ts}`, and the **screen-registry host** (`src/shell/registry.ts` exporting a `createAdminRegistry()` `ScreenRegistry` that throws on duplicate ids, + admin chrome/nav from `ScreenRegistryModule.navGroup`). Shell registers module slices; it never imports a module directly (ADR-0030). Ship `apps/admin/__tests__/admin-shell.test.ts`. → `tsc -b` + `arch:parity` + `bun run test`.
- **ADMIN-T02** Register the platform-ops roles. Add the 6 role templates (`platform_owner`, `platform_admin`, `platform_billing_admin`, `platform_support_t2`, `platform_sales`, `platform_ops`) to `packages/auth/src/roles/templates.ts` and bind the 17 M35 `billing_admin.*` permission keys to the correct roles per §4.7 (read keys → support/billing/admin/owner; write/step-up keys → billing_admin/admin/owner; `refund.approve` → admin/owner only, distinct from `refund.request`, to keep four-eyes assignable). Seed + a test asserting each key resolves to ≥1 role and that `platform_billing_scope` now admits a `platform_billing_admin`. Keep the M35 `PLATFORM_BILLING_ROLES` string array as the single source (or re-derive it from the catalog). → `arch:abac-predicates` + `bun run test`.

## Phase 1 — M35 backend gap-closure

## Module 35 — Subscription Billing (deps: [1] · `apps/backend/src/modules/35-subscription`) — 0 new tables
- **M35A-T03** Close the §5.2 backend gaps. Add `GET /api/admin/dunning` (list subscriptions by dunning stage, cursor-paged) + `DunningListResponseDto` gated `dunning.admin.read` (new read key — add to `M35_CONTRIBUTED_PERMISSIONS` + `permission-keys.ts`, ABAC `platform_billing_scope`) — **the dunning screen's only data source**. Add detail GETs `GET /api/admin/{plans,refunds,promos}/:id`. Enrich the admin list DTOs (`SubscriptionAdminResponseDto`, `RefundDto`) with an org **display name** resolved via the M2 `OrganizationReader` seam (no new `dependsOn` edge — consume the existing forward-seam). `bun run openapi:emit` → `client:gen` → add entries in `scripts/openapi/enrichments.ts`. → `arch:openapi-coverage` + `client:check` + full `arch:fitness` + `bun run test`.

## Phase 2 — M35 admin screen slice (14 screens · §5.2)

## Module 35 — Subscription Billing (deps: [1] · `apps/admin/src/modules/35-subscription-billing` [NEW]) — 0 new tables
- **M35A-T04** Slice bootstrap. Add `apps/admin/src/modules/35-subscription-billing` to **M35** `codePaths` (`.ts` + `.cjs`); `bun run scaffold` (`arch:parity`). Create the module registry `screens.ts` exporting `subscriptionAdminScreens: ScreenRegistryModule<ComponentType>` (`moduleId: 35`, `slug: "35-subscription-billing"`), register it into the M34 admin shell (`apps/admin/src/main.tsx`/`app.tsx`), and ship the **substitute registry unit test** `apps/admin/src/modules/35-subscription-billing/__tests__/screens.test.ts` (dup id/path, `requiredPermission` validated against the real `packages/auth` catalog, component binding). All screens consume the generated client (`@wardenx/ui`) + Lantern tokens + the §6.6 StatusPill taxonomy. → `arch:parity` + `bun run test`.
- **M35A-T05** **Plans + Promos** (3 screens): `/admin/plans` (list + CRUD modal, `plan.admin.read`), `/admin/plans/:id/edit` (meter mgmt + "Sync to Stripe", `plan.admin.write` — step-up + `Idempotency-Key`), `/admin/promos` (CRUD + redemption counts, `promo.admin.read/write`). → `bun run test`.
- **M35A-T06** **Subscriptions** (4 screens): `/admin/subscriptions` (cross-tenant list w/ status/plan/dunning/MRR filters, `subscription.admin.read`), `/admin/subscriptions/:id` (state history · current dunning state · usage drill-down · refund history), `/admin/subscriptions/:id/pause` (reason + until-date modal, `subscription.admin.write` — step-up+idem), `/admin/subscriptions/:id/apply_promo` (`promo.admin.apply`, ABAC `promo_applicable_to_subscription`). → `bun run test`.
- **M35A-T07** **Refunds** (3 screens — the sensitive path): `/admin/refunds` (queue by state: requested/approved/executed/failed, `refund.read`), `/admin/refunds/new` (invoice picker + 40-char-min reason, `refund.request` — step-up+idem), `/admin/refunds/:id/approve` (`refund.approve` — **step-up + four-eyes**; the UI must surface the `REFUND_FOUR_EYES` **403** (approver ≠ requester) and the stale-step-up denial as first-class outcomes, and disable approve for one's own request). → `bun run test`.
- **M35A-T08** **Dunning + Revenue + Usage + Webhooks** (4 screens): `/admin/dunning` (subscriptions by stage over the new `GET /api/admin/dunning`; per-subscription `skip_stage`/`reset` overrides, no bulk — `dunning.admin.read`/`dunning.admin.override`), `/admin/revenue` (MRR/ARR dashboard: current + trailing-12 + new/expansion/contraction/churn, `revenue.admin.read`), `/admin/usage/:organizationId` (meter-by-meter current + historical, `usage.admin.read`), `/admin/webhooks/stripe` (recent receipts w/ search by event id/status/age + "Replay" for `stripe.admin.replay`). Flip the §5.2 rows in `docs/design/DEFERRED_SCREENS.md` → `done` (§5.2 built) + §9 tests + §12 sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave acceptance
1. `apps/admin` shell exists, scaffolded 1:1 (`arch:parity` green); the 14 §5.2 screens register into the M34 admin registry and render over the live M35 admin routes + generated client.
2. Platform-ops roles are registered and each `billing_admin.*` key resolves to ≥1 role; a `platform_billing_admin` passes `platform_billing_scope` (the surface is reachable, not 403-for-all).
3. `GET /api/admin/dunning` + the detail GETs exist and are enriched; `arch:openapi-coverage` + `client:check` green; admin list DTOs carry org display names.
4. The `apps/admin` registry unit test covers dup id/path + permission-catalog validation (the ui-parity/frame-fidelity substitute); `docs/design/DEFERRED_SCREENS.md` §5.2 rows flipped `done`.
5. **No new `dependsOn` edges** (`arch:boundaries` green); **no M35→M34 import edge** (ADR-0025); Phase-3 flags stay OFF.
6. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.

> **Run sequencing** (this wave spans M34 + M35, so it is NOT a single `(Module 35 only)` run):
> 1. `archon workflow run chartwarden-piv --branch feat/admin-shell "Use the plan at docs/plans/WAVE_ADMIN_CONSOLE_M35_SUBSCRIPTION_PLAN.md (Phase 0 only — M34 admin shell + platform roles)"`
> 2. then, on top of that branch/merge: `archon workflow run chartwarden-piv --branch feat/m35-admin-console "Use the plan at docs/plans/WAVE_ADMIN_CONSOLE_M35_SUBSCRIPTION_PLAN.md (Phases 1–2 — Module 35 admin slice)"`
>
> Author/commit this plan as a **human edit** — `docs/plans/**` is read-only to the harness (`arch:plan-integrity`); use `ALLOW_PLAN_EDITS=1` only for local gate runs.
