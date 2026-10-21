# ChartWarden — Phase 1 Vertical Slice: M1 Foundation + M2 Identity (Archon task plan)

**Purpose.** The first feature work after Phase 0 (PHASE_0_SCAFFOLD_PLAN §7): a thin-but-real
vertical slice that proves the fitness gates against actual code before fanning out to all 29 Phase-1
modules. This file is the **plan an Archon workflow consumes** (`chartwarden-piv` or the bundled
`archon-plan-to-pr`): the implement-loop builds one task at a time; the `bash:` gate
(`bun run build && bun run arch:fitness && bun run test`) decides "done."

**Authority & determinism rules.**
- **Manifest is law** (`architecture/module-manifest.ts`): build exactly the `ownedTables`, in the
  declared `codePaths`, importing only `dependsOn` + leaves + foundation helpers.
- **Architecture/ADRs win over module specs.** Known conflict: the M1 spec §3.16/§3.17 references
  `packages/foundation` — **banned** (ADR-0005 D3). Place those artifacts in `packages/types` (seam
  interfaces), `packages/shared` (outbox/idempotency), `packages/tenancy` (withOrgContext + RLS),
  `packages/audit` (audit()). Treat every `packages/foundation` mention as "relocate per ADR-0005."
- **Cross-module = seam/outbox only** (no `dependsOn` edge). **PHI** = three-column rule + RLS on
  `app.org_id` + `audit()` with denylist + registered eraser.
- **Every task ends green:** `bun run build && bun run arch:fitness && bun run test`, fixtures still red.

**Task entry legend.** Each task: `id` · `deps` · `files` (manifest codePaths) · `spec §` ·
`manifest facts` · `do` · `accept` (the gate/condition that closes it). Statuses for the agent:
`todo → doing → review → done`. Do not start a task whose `deps` aren't `done`.

> **Slice scoping note.** Full M2 Definition-of-Done touches M3 (permission registration) and M4
> (audit/erasers), which are the *next* Wave-A modules. Where M2 needs them, this plan uses the
> established **deny-stub / forward-seam** pattern now and flags the wire-up for the M3/M4 tasks.
> That keeps the slice gate-green and honest. Spec: `docs/modules/CHARTWARDEN_MODULE_01_FOUNDATION_SPEC_v0_4.md`,
> `CHARTWARDEN_MODULE_02_IDENTITY_SPEC_v0_4.md`.

---

## Module 1 — Foundation  (codePaths: packages/db, packages/shared, packages/types, packages/tenancy, apps/backend/src/bootstrap)

ownedTables (16): organization, provider_entity, location, user, membership, session, account,
verification, audit_event, system_status, feature_flag, idempotency_key, outbox_event,
feature_flag_evaluation, organization_settings_registry, outbox_event_catalog.

### M1-T01 — Enums + tenancy-spine tables
- deps: — · files: `packages/db/src/schema` · spec §3.2, §3.3–3.5
- do: Drizzle enums (§3.2); `organization`, `provider_entity`, `location` with the three-column
  spine. These are the tenancy spine (NON_ORG_SCOPED in the tenancy check — they define org scope).
- accept: `bun run arch:ddl` + `arch:tables` green; `tsc -b` green.

### M1-T02 — Identity base tables (Better Auth–compatible)
- deps: T01 · files: `packages/db/src/schema` · spec §3.6–3.8
- do: `user`, `membership`, `session`, `account`, `verification`. `user/account/verification/session`
  are cross-org (NON_ORG_SCOPED); `membership` is org-scoped.
- accept: `arch:tables` green (M1 owns all); `tsc -b` green.

### M1-T03 — Audit + platform tables
- deps: T01 · files: `packages/db/src/schema` · spec §3.9–3.10
- do: partitioned `audit_event` (§3.9); `system_status`, `feature_flag`, `idempotency_key`,
  `outbox_event`, `feature_flag_evaluation`, `organization_settings_registry`, `outbox_event_catalog`.
  `audit_event`/`outbox_event`/`idempotency_key` are HELPER-ONLY (written via helpers, not feature modules).
- accept: `arch:ddl` (partition key in any unique index), `arch:tables`, `tsc -b` green.

### M1-T04 — Initial migration: RLS + partitioning + DB roles
- deps: T01–T03 · files: `packages/db/migrations`, `packages/db` · spec §3.11–3.12
- do: `bunx drizzle-kit generate`; enable RLS + policies (canonical `app.org_id` only), monthly
  partition rotation for `audit_event`, DB roles `chartwarden_app`/`chartwarden_admin`/`chartwarden_audit_writer`,
  the append-only GRANT model, organization-settings + outbox-catalog migration.
- accept: `arch:tenancy` (canonical var, three-column, no `OR org IS NULL` write) + `arch:ddl` green;
  RLS isolation integration test (T12) drafted.

### M1-T05 — RLS policy generator
- deps: T04 · files: `packages/tenancy` · spec §3.13
- do: the policy-generator utility that emits standard per-table RLS keyed on `app.org_id`.
- accept: unit test generates a policy that the tenancy check accepts; `tsc -b` green.

### M1-T06 — Context helpers (withOrgContext / withPlatformContext)
- deps: T05 · files: `packages/tenancy` · spec §3.14
- do: `withOrgContext()` sets `app.org_id`; `withPlatformContext()` for platform role; request-context plumbing.
- accept: `arch:tenancy` green; unit test asserts the session var is set/reset.

### M1-T07 — Organization-settings registry + typed reader
- deps: T06 · files: `packages/tenancy` (or `packages/shared`), `packages/db/src/schema` · spec §3.15
- do: the typed `OrganizationSettingsReader` pattern over `organization_settings_registry`
  (collision rejection per W-M1-08).
- accept: unit test for collision rejection; gates green.

### M1-T08 — Outbox dispatcher + event catalog
- deps: T03, T06 · files: `packages/shared`, `packages/types` · spec §3.17
- do: outbox dispatcher + idempotency middleware (`packages/shared`); event-name types in
  `packages/types`; an `events-by-m1.ts` contribution; unknown-event refusal (W-M1-09); catalog
  payload validation (W-M1-11).
- accept: `arch:gaps` event-catalog **arms** and passes (mN naming, valid consumers); gates green.

### M1-T09 — Seam registry & boot validation (promote Phase-0 stub to real)
- deps: T06 · files: `apps/backend/src/bootstrap` · spec §3.18
- do: extend the Phase-0 `seams/registry.ts` + `erasers/registry.ts` to the real contract surface;
  `validateSeams()`/`validateErasers()` fail closed; seam interfaces stay in `packages/types`.
- accept: boot smoke test (extend `scripts/__tests__/bootstrap.test.ts`); `arch:gaps` seam-registry
  passes; gates green.

### M1-T10 — API routes, error envelope, middleware
- deps: T06, T08 · files: `apps/backend/src/modules`* / `apps/backend/src/bootstrap` · spec §4.1–4.6.1
- do: health/status + feature-flag routes; standard error envelope + Fastify error handler;
  request-context middleware; idempotency middleware (W-M1-10 idempotent mutations); security baseline.
- accept: integration test for idempotent mutation + degraded-mode; gates green.

### M1-T11 — Shared UI components + degraded-mode banner
- deps: — (parallel) · files: `packages/ui` · spec §5.1–5.2
- do: shared UI components delivered by M1; degraded-mode banner. (If M1 has screen specs under
  `docs/design/`, implement them.)
- accept: `docs:ui` green; `tsc -b` green.

### M1-T12 — Audit helper, retention classes, erasers, permissions, tests
- deps: T03, T04, T09 · files: `packages/audit`, `apps/backend/src/bootstrap` · spec §6, §7
- do: `audit()`/`auditRead()` helper + field denylist; retention-class registry; register M1 erasers;
  permissions matrix (§6); acceptance tests §7 — **PHI isolation across tenants (§7.2)**, audit-trail
  reliability (§7.3), idempotency (§7.4), operational visibility (§7.5).
- accept: full `bun run arch:fitness` + Vitest green incl. RLS cross-tenant isolation; `validateErasers()` passes.

---

## Module 2 — Identity & Org  (codePaths: packages/auth/src/identity, apps/backend/src/modules/02-identity; depends on M1)

ownedTables (4): two_factor, passkey, organization_invitation, tenant_step_up_policy_override.

### M2-T01 — Better Auth integration
- deps: M1 done · files: `packages/auth/src/identity` · spec §1, §3.1
- do: configure Better Auth (ADR-0026) against M1's `user/session/account/verification`; the
  `better-auth` import is allowed **only** here (vendor-adapter rule).
- accept: `arch:boundaries` vendor-adapter rule green; `tsc -b` green.

### M2-T02 — M2 schema + RLS + migration
- deps: M2-T01 · files: `packages/db/src/schema`, `packages/db/migrations` · spec §3.3–3.7, §3.8–3.9
- do: `two_factor`, `passkey` (user-owned, NON_ORG_SCOPED), `organization_invitation`,
  `tenant_step_up_policy_override`; RLS (§3.8); migration (§3.9).
- accept: `arch:tables` (M2 owns these), `arch:tenancy`, `arch:ddl` green.

### M2-T03 — Session classes + session fields
- deps: M2-T01 · files: `packages/auth/src/identity` · spec §3.6, §2.2
- do: the four session classes (staff / auditor / external_collaborator / funeral_home) + the
  additional session fields; lifecycle states (§2.2).
- accept: unit tests on session-class scoping; gates green.

### M2-T04 — STEP_UP_POLICY constant (leaf-homed)
- deps: M2-T01 · files: `packages/types` · spec §4.3
- do: `STEP_UP_POLICY` (and SESSION_POLICY) constants in `packages/types` (re-homed from the banned
  `packages/foundation` per ADR-0005 D3).
- accept: `tsc -b` + `arch:boundaries` green.

### M2-T05 — Step-up route + login-MFA init
- deps: M2-T03, M2-T04 · files: `apps/backend/src/modules/02-identity` · spec §4.4
- do: the step-up route + login-MFA initialization; W-M2-08/09 (step-up updates session),
  W-M2-10 (tenant tightening → WebAuthn-only for SUD path), W-M2-11 (SMS ≠ step-up).
- accept: integration tests for §7.8–7.11; routes behind context guards; gates green.

### M2-T06 — Identity route inventory
- deps: M2-T02, M2-T03 · files: `apps/backend/src/modules/02-identity` · spec §4.1–4.2
- do: invite/onboard, offboard, 2FA enroll/recover, passkey enroll/login routes; each behind
  `requirePermission`/`requireAbac` (deny-stub the M3 guard until M3 lands — flag it).
- accept: integration tests for §7.1–7.7 happy paths; gates green.

### M2-T07 — Cross-module contracts (seams)
- deps: M1-T09, M2-T03 · files: `packages/auth/src/identity`, `apps/backend/src/bootstrap` · spec §4.7
- do: register M2's published seams (actor/session resolution) into the M1 registry; interfaces in
  `packages/types`.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green.

### M2-T08 — Audit events + permission keys  *(partial: wires fully when M3/M4 land)*
- deps: M2-T06 · files: `apps/backend/src/modules/02-identity`, `packages/auth/src/identity` · spec §6, §8.1
- do: emit M2 audit events (§8.1) via `audit()` with denylist; declare M2 permission keys + ABAC
  predicates (register into M3 when M3 exists — deny-stub registry now).
- accept: audit events present + denylist applied; gates green. (M3 registration tracked as follow-up.)

### M2-T09 — Frontend screens  *(BLOCKED — unresolved plan↔manifest conflict; see ADR-0030)*
- deps: M2-T05, M2-T06 · files: `apps/portal`/`apps/backend` UI per spec · spec §5.1–5.4
- do: login, MFA, passkey enroll, invite, member-management screens; Capacitor mobile variants; WCAG 2.1 AA.
- accept: `docs:ui` green; `tsc -b` green.

> **STATUS — BLOCKED (recorded by maintainer 2026-06-14).** This task as written cannot be built
> under M2. The manifest (law) scopes M2 to `packages/auth/src/identity` +
> `apps/backend/src/modules/02-identity` — **M2 owns no frontend codePath**. The screens named here are
> *core/app-shell* identity flows (authoritative spec: `docs/design/screens/core/CHARTWARDEN_UI_AUTH.md`), **not**
> portal screens — yet this task points them at `apps/portal` (manifest owner: **M31**, the patient/family
> portal) and `apps/admin` (manifest owner: **M34**, the SaaS tenant platform). Neither M31 nor M34 is the
> obvious home for *core staff* auth UI, and no core front-end app exists in the tree (`apps/` = `admin`,
> `backend`, `portal` only).
>
> **This is an open architecture decision, not a deferral an implementer may self-authorize.**
> The owning app + module for core auth UI must be chosen by a human/architect — tracked in
> **[ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md)** (proposed). Until ADR-0030 lands, M2-T09
> is **out of scope for the M1+M2 backend slice** (whose acceptance criteria, below, are backend-only).
> Do **not** build these screens in `apps/portal` / `apps/admin` (would break `arch:parity`), and do **not**
> edit this plan to manufacture a resolution — surface the conflict instead (`confirm-plan` says *STOP if
> ambiguous*). Note for automated runs: `docs/plans/**` is read-only to the harness (`arch:plan-integrity`).

### M2-T10 — DR tier + INT inventory + eraser
- deps: M2-T02 · files: module + bootstrap · spec §8, roadmap DoD
- do: declare DR tier (per CHARTWARDEN_DR_BCP) + INT inventory (per CHARTWARDEN_INTEGRATIONS) for auth
  touchpoints; register M2 eraser.
- accept: `validateErasers()` passes; docs present; gates green.

### M2-T11 — Test plan (the slice's proof)
- deps: all M2 · files: module + `packages/auth` · spec §9.1–9.5
- do: unit (policy/crypto ≥90% — §9.1), integration on Testcontainers PG+Valkey (§9.2), **RLS
  cross-tenant denial (§9.3)**, cross-module assertion (§9.4), Playwright E2E (§9.5).
- accept: `bun run test` green incl. RLS isolation; full `arch:fitness` green.

---

## Slice acceptance (the workflow's final gate)
1. M1 ownedTables (16) + M2 ownedTables (4) exist as Drizzle tables with RLS + migrations; **no other**
   tables introduced (manifest unchanged).
2. `bun run build && bun run arch:fitness && bun run test` green; the Phase-0 fitness fixtures stay red.
3. RLS cross-tenant isolation tested for every PHI table in the slice.
4. `validateSeams()` + `validateErasers()` pass at boot with real M1/M2 registrations.
5. The "one seam + one route" thin-slice goal is exceeded: real auth routes behind context + a
   registered cross-module seam. Any M3/M4-dependent wiring is a deny-stub with a tracked follow-up.

---

## Reusable per-module task template (DoD-aligned) — for the remaining 27 Phase-1 modules

For each subsequent module N (build in `PHASE_1_PLAN.md` wave order), generate these tasks from the
manifest + the module spec. Each maps to one Definition-of-Done line and closes on a specific gate:

| # | Task | Source | Closes on |
|---|---|---|---|
| N-T01 | Drizzle schema for every `ownedTables[N]` (+ three-column rule on PHI) | manifest + spec §3 | `arch:tables`, `arch:tenancy` |
| N-T02 | Migration generated + legal | spec §3 migration | `arch:ddl` |
| N-T03 | RLS policies + `withOrgContext` on every PHI route | spec §3 RLS / §4 | `arch:tenancy`; RLS isolation test |
| N-T04 | Routes per route inventory, behind `requirePermission`/`requireAbac` (+ step-up where specified) | spec §4 | integration tests; `arch:boundaries` |
| N-T05 | Permission keys + ABAC predicates registered into M3; audit events (M4) + denylist | spec §6, §8 | `arch:gaps`; audit tests |
| N-T06 | Published seams registered into M1 registry | spec cross-module §| `validateSeams()`; `arch:gaps` seam |
| N-T07 | Outbox events `mN.<resource>.<verb>`; consumers wired or deny-stubbed | spec events | `arch:gaps` event-catalog |
| N-T08 | UI screens per `docs/design/screens/*` using the declared layout pattern | spec §5 + `docs/design` | `docs:ui` |
| N-T09 | Eraser registered with M4 | spec §retention | `validateErasers()` |
| N-T10 | DR tier + INT inventory; degraded-mode where on a cross-phase path | DR/INT docs | docs present |
| N-T11 | Unit + integration (Vitest) incl. RLS cross-tenant + spec's enumerated cases | spec §test plan | `bun run test`; full `arch:fitness` |

**Phase-1 scope flags stay default-off** (PHASE_1_PLAN §3): `hearthnote.layer2`, `documents.doclens`,
`scheduling.route_optimization`, `ai.full`, `dosespot.epcs`, `fhir.write`, `saas.multi_tenant`,
`quality.cahps`, `cap.full_projection`. No Phase-1 route may hard-depend on a flag being on.
