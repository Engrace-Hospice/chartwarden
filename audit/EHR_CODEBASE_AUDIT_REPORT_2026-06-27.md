# EHR Codebase Audit Report

## 1. Executive Summary

### Overall Status
Blocked

The implemented WardenX surface is architecturally disciplined, with strong manifest-driven boundaries, generated status reports, RLS/audit-trigger conventions, and substantial landed work across M2-M14, M17, M18, M22, M33, M34, M36, M38, M39, and M40. The current working tree is nevertheless blocked because the in-progress M30 Quality slice is partially added: repository code references database schema symbols that are not exported, boundary rules fail, tenancy rules fail, tests fail, and the status matrix is stale.

This audit does not penalize planned modules that remain honest placeholders. The highest risks are implemented-or-referenced behavior that is not wired safely in production: ABAC/step-up evaluator installation, PHI read audit coverage, route-level frontend auth guarding, PHI leakage through URLs/localStorage/logs, document export controls, M34 platform-bypass audit wiring, and M30 quality schema/migration drift.

### Top 10 Findings

| # | Severity | Area | Finding | Impact | Recommended Fix |
|---|----------|------|---------|--------|-----------------|
| 1 | Critical | Build / M30 Quality | `packages/quality/src/repositories/*` imports `schema.*` symbols that `packages/db/src/schema/index.ts` does not export. `bun run build` and `bun run typecheck` fail with TS2339/TS2694 across M30 repositories. | App cannot build with current working tree. | Either remove the in-progress repositories from compilation until ready, or export `./quality` from the DB schema barrel after fixing tenancy/spec drift and migrations. |
| 2 | Critical | Architecture boundaries | `bun run arch:fitness` fails in `arch:boundaries` with 9 M30 violations: `packages/quality/src/repositories/* -> packages/db/src/index.ts`. | Fitness gate blocks CI and prevents safe landing. | Decide whether M30 may import `@wardenx/db` as a foundation helper in this package path; update manifest/rules intentionally or move repository code to an allowed backend/module path. |
| 3 | Critical | Auth/ABAC | `packages/auth/src/abac/require-abac.ts` defaults to deny-all; `registerAbacRegistry()` appears in tests but not production boot, and no `registerPredicate("step_up_recent", ...)` exists. | Mounted `requireAbac` / `requireStepUp` routes deny in production, including M33, M34, M36, M39, and M40 protected actions. | Install the ABAC registry in `apps/backend/src/index.ts` boot and register `step_up_recent` against M2 session step-up state. |
| 4 | High | HIPAA / Audit | PHI read audit helpers exist (`packages/audit/src/read/audit-read.ts`) but PHI routes do not consistently call or assert them; `assertReadAuditDeclared()` is imported in M4 but not enforced globally. | Weak HIPAA audit controls for read/access accounting. | Add route-level read-audit middleware or explicit `auditPhiRead`/`auditListRead` calls and assert coverage during boot. |
| 5 | High | Privacy / Logging | Fastify logger is configured without Pino redaction and logs request URLs; patient/global search persists query terms to `localStorage`. | PHI can leak to browser storage, browser history, proxy logs, and application logs. | Redact URLs/query strings and sensitive fields; stop storing PHI search terms in `localStorage`; consider POST/opaque search IDs for patient search. |
| 6 | High | Frontend auth | `AppShell` mounts chromed routes without a session guard, and `canSeeScreen()` is fail-open when permissions are unknown. | Unauthenticated or unresolved sessions can view route chrome/nav and potentially screen structure. | Add loading/authenticated/anonymous session states and protect chromed routes; make nav permission filtering fail-closed while loading. |
| 7 | High | M30 database | M30 quality schema has no migration files, is not exported from the DB barrel, and `arch:tenancy` reports missing PHI spine columns on `incident_report`, `cahps_decedent_sample`, and `infection_surveillance_event`. | Runtime table absence, RLS/audit absence, and PHI tenancy non-compliance. | Reconcile M30 schema to spec, add provider/location columns, generate tables + RLS/audit migrations, then refresh status matrix. |
| 8 | High | Database reproducibility | `packages/db/migrations/meta/_journal.json` stops at `0049`, while SQL files reach `0061`; `0024`, `0025`, and `0050`-`0061` are not journaled. | Drizzle Kit metadata is stale; future generate/migrate flows can diverge from the applied SQL corpus. | Reconcile journal/snapshots or declare `scripts/db/migrate.ts` the sole authoritative migrator and add a CI check for journal parity. |
| 9 | High | M34 platform ops | `m34FailClosedBypassAuditor` in `apps/backend/src/index.ts` throws; platform cross-tenant reads 5xx until M4 bypass audit is bound. | Platform ops routes are mounted but fail for audited cross-tenant reads. | Bind the real M4 `platform.bypass_invoked` audit emitter before mounting platform routes. |
| 10 | High | Dependencies | `bun audit` reports 7 vulnerabilities: `vitest` critical, `drizzle-orm` high, `vite` high/moderate, `esbuild` moderate, `js-yaml` moderate. | Known vulnerable tooling/runtime dependencies in an ePHI system. | Update vulnerable dependencies, rerun build/typecheck/test/fitness/audit. |

### Immediate Priorities

1. Stabilize or isolate the M30 Quality working tree so `bun run build`, `bun run typecheck`, `bun run test`, and `bun run arch:fitness` can pass again.
2. Wire the production ABAC evaluator and `step_up_recent` predicate before relying on mounted step-up/ABAC routes.
3. Add route-level frontend auth protection and fail-closed permission rendering during session loading.
4. Implement PHI-safe logging/search storage and read-audit enforcement for PHI GET/download/export routes.
5. Reconcile DB migration metadata and add M30 migrations only after the schema matches tenancy/spec requirements.

---

## 2. Repository Inventory

### Applications

| Application | Current State | Evidence |
|---|---|---|
| `apps/backend` | Fastify host and composition root. Mounts M2, M3, M4, M5, M33, M34, M36, M38, M39, M40 when `DATABASE_URL` is set; clinical M6-M14/M17/M18/M22 route modules exist but are not mounted in production root. | `apps/backend/src/index.ts:379`-`426` |
| `apps/web` | Vite/React shell with registry-driven screens. UI parity reports 109 registered screens across 113 documented screen specs. | `apps/web/src/main.tsx`, `audit/ui-parity/UI_PARITY.md` |
| `apps/portal` | Phase 0 placeholder. | `apps/portal/src/index.ts` |

### Packages

| Package Area | Current State | Evidence |
|---|---|---|
| Foundation | `@wardenx/db`, `@wardenx/shared`, `@wardenx/types`, `@wardenx/tenancy`, `@wardenx/audit`, `@wardenx/auth` provide schema, seams, errors, tenancy, audit, RBAC/ABAC. | `architecture/module-manifest.ts:68`-`97` |
| Domain packages | Many modules have real package code (`messaging`, `reporting`, `consent`, `mdm`, `saas-tenant-platform`, clinical packages). | `package.json` workspaces; package manifests |
| M30 Quality | Untracked DB schema, lifecycle, and repository files exist, but package root still exports placeholder. | `packages/quality/src/index.ts`, `packages/quality/src/repositories/*`, `packages/db/src/schema/quality/*` |
| Admin UI shell | `@wardenx/admin-ui-shell` exports platform shell components but is not imported by `apps/web`. | `packages/admin-ui-shell/src/index.ts`; no consumer import found |

### Backend Modules

| Status | Modules | Evidence |
|---|---|---|
| Production-mounted | M2, M3, M4, M5, M33, M34, M36, M38, M39, M40 | `apps/backend/src/index.ts:381`-`425` |
| Implemented/tested but not mounted in production root | M6, M7, M8, M9, M10, M11, M12, M13, M14, M17, M18, M22 | Route/test files under `apps/backend/src/modules/{06..14,17,18,22}-*` and `apps/backend/__tests__` |
| Stub / placeholder | M15, M16, M19-M21, M23-M32 except M33/M34, M37 | `audit/implementation-status/IMPLEMENTATION_STATUS.md` |
| WIP but not coherent | M30 Quality | Untracked schema/repo files and failing commands |

### Frontend Areas

| Area | Current State | Evidence |
|---|---|---|
| Shell/router | Registry-driven routes with chromeless auth/system pages and chromed app layout. | `apps/web/src/shell/app.tsx:54`-`75` |
| Session context | Self-loads `/api/v1/auth/context`, but exposes only `Session | null`, not loading/error/authenticated states. | `apps/web/src/shell/session.tsx:38`-`57` |
| Permission nav | `canSeeScreen()` returns true when permissions are unknown. | `apps/web/src/shell/actor-session.ts:44`-`50` |
| API client | Generated OpenAPI client is fresh, but several screens use `as never` casts around missing query/body/path types. | `bun run client:check`; `apps/web/src/modules/33-reporting/*`, `apps/web/src/modules/34-saas/*` |

### Database Layer

| Area | Current State | Evidence |
|---|---|---|
| Schema barrel | Exports through M33/M34 but not M30 quality. | `packages/db/src/schema/index.ts:465`-`493` |
| Migrations | 62 SQL migration files exist, `0000` through `0061`. | `packages/db/migrations/*.sql` |
| Drizzle metadata | `_journal.json` stops at `0049_documents_m22_rls_audit_triggers`; no journal entries for `0050`-`0061`. | `packages/db/migrations/meta/_journal.json:335`-`340` |
| M30 schema | Has 18 Drizzle tables under `packages/db/src/schema/quality`, no migrations and no root barrel export. | `packages/db/src/schema/quality/index.ts`; migration search |

### Specs and Docs

| Area | Current State | Evidence |
|---|---|---|
| Architecture docs | Authoritative docs under `docs/architecture`, module manifest under `architecture/`. | `CLAUDE.md` |
| Module specs | All module specs under `docs/modules`. | `docs/modules/README.md` |
| UI specs | 113 documented screen specs; docs check passes. | `bun run docs:ui` |
| Top-level README | `README.md` is absent in the repo root. | `ReadFile /Users/fabrice/Apps/WardenX/README.md` returned file-not-found |
| Generated reports | UI parity/frame fidelity fresh; implementation status stale under current working tree. | `arch:ui-parity`, `arch:frame-fidelity`, `arch:status-matrix` |

### CI/CD and Tooling

| Tooling | Current State | Evidence |
|---|---|---|
| Package manager | Bun workspace; pnpm is not configured. | `package.json:6`-`12`, `bun.lock`, no `pnpm-workspace.yaml` |
| CI | GitHub Actions runs install/build/fitness/test per development docs. | `.github/workflows/ci.yml`, `docs/DEVELOPMENT.md:95`-`105` |
| Fitness gates | Strong architecture gates exist, but current M30 WIP fails boundary/tenancy/status/test gates. | Command results |
| Lint/format | Biome check exists; no separate `format:check` script. | `package.json:31`-`32` |

---

## 3. Commands Run and Results

| Command | Result | Key Output | Root Cause If Failed | Fix |
|--------|--------|------------|----------------------|-----|
| `bun install --frozen-lockfile` | Passed | Checked 478 installs across 664 packages; no changes. | N/A | N/A |
| `pnpm install --frozen-lockfile` | Failed / Not applicable | `ERR_PNPM_NO_LOCKFILE`; pnpm warns `workspaces` field is unsupported without `pnpm-workspace.yaml`. | Repo is Bun-based and has no pnpm lock/workspace config. | Use `bun install --frozen-lockfile`; do not add pnpm unless intentionally migrating package managers. |
| `bun run build` | Failed | TS2339/TS2694 in `packages/quality/src/repositories/*`: missing M30 schema exports from `@wardenx/db`. | M30 repositories compile against non-exported DB schema symbols. | Export quality schema only after fixing M30 schema/migrations, or keep WIP repositories out of compilation. |
| `bun run typecheck` | Failed | Same M30 missing export errors; output 624 lines. | Same as build. | Same as build. |
| `bun run lint` | Failed | Biome import ordering/formatting failures, starting in `apps/backend/__tests__/assessment-eraser.test.ts` and `assessment-jobs.test.ts`. | Unformatted/import-unsorted files in current tree. | Run `bun run lint:fix` after functional blockers are resolved and review generated formatting changes. |
| `bun run test` | Failed | 252 files passed, 1 failed, 5 skipped; 3020 tests passed, 2 failed, 160 skipped, 12 todo. Failing tests are fitness gate baseline `tenancy` and `boundaries`. | Current repo root no longer has green baseline because M30 WIP violates tenancy and dependency-cruiser boundaries. | Fix or isolate M30 WIP; rerun tests. |
| `bun run arch:fitness` | Failed | Stops in `arch:boundaries`: 9 `module-30-boundary` errors from `packages/quality/src/repositories/*` to `packages/db/src/index.ts`. | M30 package import shape violates generated module boundary rules. | Update M30 package architecture or manifest/rule model intentionally. |
| `bun run arch:tables` | Passed | `no cross-module schema access, raw-SQL, or platform-bypass evasion`. | N/A | N/A |
| `bun run arch:tenancy` | Failed | 3 violations: `cahps_decedent_sample`, `infection_surveillance_event`, `incident_report` missing provider/location PHI spine columns. | M30 schema drafted org-scoped while PHI tables require ARCH-011 three-column shape. | Add required `provider_entity_id` and `location_id` columns per PHI table and spec. |
| `bun run arch:ddl` | Passed | No CHECK subqueries, duplicate enums, partition-key/unique conflicts. | N/A | N/A |
| `bun run arch:gaps` | Passed | Scanned 313 schema files and 191 org-scoped tables. | N/A, but note Drizzle-only M30 tables without migrations are only partially covered. | Extend PHI guard scan to enforce RLS/audit even for Drizzle-only owned tables. |
| `bun run arch:ai-governance` | Passed | 12 architecture-listed capabilities cataloged. | N/A | N/A |
| `bun run arch:plan-integrity` | Passed | No plan files modified. | N/A | N/A |
| `bun run arch:status-matrix` | Failed | `IMPLEMENTATION_STATUS.md is out of date. Run: bun run status:matrix`. | Working tree added M30 schema/repository files without regenerating status artifacts. | Regenerate after M30 landing decision. |
| `bun run arch:ui-parity` | Passed | 113 documented, 109 screens registered. | N/A | N/A |
| `bun run arch:frame-fidelity` | Passed | 17 mapped, 3 matched, 14 partial. | N/A | N/A |
| `bun run docs:ui` | Passed | 113 screens, 29 patterns, 113 index entries. | N/A | N/A |
| `bun run openapi:check` | Passed | `openapi.json up to date (532 routes, 120 enriched)`. | N/A | Remove `as never` casts by enriching missing route schemas even if generated file is fresh. |
| `bun run client:check` | Passed | Generated client matches `docs/api/openapi.json`. | N/A | N/A |
| `bun run format:check` | Failed / Unsupported | `Script not found "format:check"`. | No script exists. | Add `format:check` alias to `biome check .` or document `bun run lint`. |
| `bun run db:check` | Failed / Unsupported | `Script not found "db:check"`. | No script exists. | Add a non-mutating DB/migration check if desired. |
| `bun run db:migrate` | Failed | `ECONNREFUSED 127.0.0.1:5440` and `::1:5440`. | Local Postgres container was not running; did not run `db:up` because that mutates local Docker state. | Start DB with `bun run db:up` when desired, then rerun migrations. |
| `bun audit` | Failed | 7 vulnerabilities: 1 critical, 2 high, 4 moderate. | Vulnerable dependency versions. | Update `vitest`, `drizzle-orm`, `vite`, `esbuild` transitive path, and `js-yaml` path where possible. |

---

## 4. Architecture and Specification Drift

| Severity | File(s) | Drift Type | Expected | Actual | Impact | Fix |
|----------|---------|------------|----------|--------|--------|-----|
| Critical | `packages/quality/src/repositories/*`, `packages/db/src/schema/index.ts` | M30 build/schema wiring | Repository code should consume exported schema symbols or remain uncompiled. | Repositories import M30 symbols that are not exported from DB barrel. | Build/typecheck fail. | Land M30 coherently or isolate WIP. |
| Critical | `packages/quality/src/repositories/*`, `architecture/.dependency-cruiser.cjs` | Module boundary | M30 imports must follow manifest-generated boundaries. | 9 dependency-cruiser M30 boundary errors importing `packages/db/src/index.ts`. | `arch:fitness` and tests fail. | Update M30 architecture or dependency rule intentionally. |
| High | `architecture/module-manifest.ts`, `apps/web/src/modules/33-reporting`, `apps/web/src/modules/34-saas` | Manifest ownership | Modules with web screens should include web code paths in manifest. | M33/M34 screens are registered in web but manifest lists backend/package paths only. | Implementation status false negatives; boundary blind spot. | Add `apps/web/src/modules/33-reporting` and `apps/web/src/modules/34-saas` to manifest code paths and regenerate reports. |
| High | `packages/admin-ui-shell`, `apps/web/src/modules/34-saas/*` | Spec/package integration | M34 platform ops shell package should wrap M34 surfaces if implemented. | Package exports `PlatformOpsShell` / `SupportSessionBanner`, but `apps/web` has no dependency/import. | Platform support-session UX and tenant context shell are absent. | Integrate admin UI shell or mark package as deferred. |
| High | `docs/DEVELOPMENT.md`, `drizzle.config.ts`, `packages/db/migrations/meta/_journal.json` | Migration authority | One documented migration authority and fresh metadata. | Custom SQL migrator applies all files; Drizzle journal stops at 0049. | Future DB generation/reproduction drift. | Reconcile journal or enforce custom migrator as sole authority. |
| Medium | `docs/design/FRONTEND_RECONCILIATION_SCOPE.md`, `docs/design/DEFERRED_SCREENS.md`, `CLAUDE.md` | Documentation freshness | Docs should reflect landed M9-M14/M17/M18/M22/M33/M34 surface. | Some docs still describe older counts/backlogs. | Planning confusion, stale audit baselines. | Refresh wave/module status docs. |
| Medium | `scripts/report-implementation-status.ts`, `audit/implementation-status/*` | Generated report freshness | Generated reports fresh under current tree. | `arch:status-matrix` fails. | CI blocks. | Regenerate after deciding M30 landing scope. |
| Low | `drizzle.config.ts:3`-`8` | Comment drift | Config comments should match current schema state. | Comment still says Phase 0/no tables. | Minor confusion. | Update comment. |

---

## 5. Module-by-Module Audit

### Module: M1 Foundation

#### Status
Partial / implemented foundation.

#### Files Reviewed
`architecture/module-manifest.ts`, `apps/backend/src/bootstrap/*`, `packages/db`, `packages/shared`, `packages/types`, `packages/tenancy`, `apps/web/src/shell/*`.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| High | Fastify logging has no PHI redaction. | `apps/backend/src/bootstrap/index.ts:105`-`107` configures only logger level. | Request URLs/query strings and errors can leak PHI. | Configure Pino `redact` using audit denylist paths and URL/query redaction. |
| Medium | Idempotency defaults to in-memory store. | `apps/backend/src/bootstrap/index.ts:120` | Multi-instance production can duplicate unsafe writes. | Inject Postgres/Valkey-backed store in production. |
| Medium | In-memory global rate limiter. | `apps/backend/src/bootstrap/plugins/security.ts` | Not cluster-safe. | Use shared limiter store. |

#### Drift Risks
Foundation gates are good, but generated reports can become misleading when new code is added outside manifest-owned paths or when Drizzle-only schema appears before migrations.

#### Required Remediation
Add PHI-safe logging, production idempotency/rate-limit stores, and extend parity/PHI guards to cover Drizzle-only owned tables and web subpaths.

### Module: M2 Identity & Org

#### Status
Implemented / partial production wiring.

#### Files Reviewed
`apps/backend/src/modules/02-identity`, `packages/auth/src/identity`, `apps/web/src/modules/02-identity`.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| High | Step-up state exists but `step_up_recent` predicate is not registered. | `requireStepUp()` delegates to `step_up_recent` in `packages/auth/src/abac/require-abac.ts:192`-`195`; search found no `registerPredicate("step_up_recent", ...)`. | Step-up routes deny or remain test-only. | Register predicate using M2 session context and policy resolver. |
| High | Production auth env does not fail closed. | Raw `process.env` reads in `apps/backend/src/index.ts:340`-`365`; auth config receives env indirectly. | Weak/missing auth secrets/origins can reach runtime. | Add startup env schema requiring strong production values. |
| Medium | Some identity stores are in-memory in production mount. | Backend subaudit found invitations/collaborators/user directory/audit sink in `mountIdentityRoutes`. | Admin workflows may lose state or lack audit fidelity. | Replace in-memory deps with Drizzle stores. |

#### Drift Risks
Step-up is a cross-module invariant; if predicate registration remains test-local, future high-PHI actions will appear guarded but deny or behave inconsistently.

#### Required Remediation
Wire `step_up_recent`, validate auth env, and replace remaining production in-memory stores.

### Module: M3 Authorization

#### Status
Implemented / partial production wiring.

#### Files Reviewed
`packages/auth/src/rbac`, `packages/auth/src/abac`, `apps/backend/src/modules/03-authorization`.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| Critical | ABAC evaluator is not installed in production boot. | Default deny evaluator in `packages/auth/src/abac/require-abac.ts:65`-`70`; `registerAbacRegistry()` found in tests, not boot. | Mounted ABAC routes deny in production. | Call `registerAbacRegistry()` in composition root after predicate registration. |
| High | Break-glass contract is not wired at boot. | Backend audit found `registerBreakGlassContract()` used in tests only. | Emergency access path unavailable. | Register real Drizzle break-glass resolver and critical audit hook. |
| High | Sensitive M3 route dependencies are partly in-memory. | Backend audit found `mountAuthorizationRoutes` uses in-memory break-glass/engagements/audit and fixed permission resolver. | Production authorization/admin behavior incomplete. | Replace with Drizzle stores and shared RBAC resolver. |

#### Drift Risks
Guard functions compile and tests pass in slice mode, but production composition can remain fail-closed or in-memory unless boot wiring is part of fitness tests.

#### Required Remediation
Add production boot tests that assert ABAC registry, step-up, break-glass, and permission resolver are installed.

### Module: M4 Audit & Compliance Log

#### Status
Implemented / partial.

#### Files Reviewed
`packages/audit`, `apps/backend/src/modules/04-audit`, audit migrations.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| High | PHI read audit is not globally enforced. | Helpers exist in `packages/audit/src/read/audit-read.ts`; search shows no global boot assertion use across PHI routes. | HIPAA audit controls incomplete. | Enforce read-audit declaration/calls for all PHI GET/download/export routes. |
| High | M34 platform bypass auditor is fail-closed typed TODO. | `apps/backend/src/index.ts:253`-`257` throws. | Platform cross-tenant reads 5xx. | Bind M4 `platform.bypass_invoked` emitter. |
| Medium | Audit workers not started. | `apps/backend/src/index.ts:442`-`448` comments defer M4 workers. | Retention/integrity/destruction jobs do not run. | Start M4 workers with production adapters. |

#### Drift Risks
Write audit triggers are strong, but read audit can drift because route coverage is not yet an enforced global invariant.

#### Required Remediation
Make PHI read-audit coverage a boot/fitness check and wire workers.

### Module: M5 Patient

#### Status
Implemented / production-mounted.

#### Files Reviewed
`apps/backend/src/modules/05-patient`, `apps/web/src/modules/05-patient`, patient schema/migrations.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| High | Patient/global search can leak PHI. | `apps/web/src/modules/05-patient/global-search.tsx:52`-`73` persists search terms to `localStorage`; backend/search routes use query URLs. | Patient names/MRNs can persist in browser storage/history/logs. | Do not store PHI search terms; use in-memory/server-side TTL recents and POST/opaque IDs. |
| Medium | Patient chart navigation is stale relative to shipped modules. | Frontend audit found `patient-chart.tsx` marks modules not ready while routes exist. | Users cannot navigate implemented chart areas consistently. | Use shared `ChartModuleRail` and set shipped modules ready. |
| High | SSN/identifier reveal is display-only. | Frontend audit found `MaskedIdentifier` without `onReveal` in `patient-chart.tsx`. | No audited step-up reveal path. | Wire reveal to step-up + audit endpoint. |

#### Drift Risks
Patient is a hub; stale chart navigation quickly creates frontend/backend mismatch as clinical modules land.

#### Required Remediation
Fix PHI search handling, audited identifier reveal, and shared patient-workspace navigation.

### Module: M6-M14, M17, M18, M22 Clinical Modules

#### Status
Implemented/tested in slices; many routes are not production-mounted.

#### Files Reviewed
`apps/backend/src/modules/06-admission` through `14-idg`, `17-scheduling`, `18-evv`, `22-documents`, corresponding `apps/web/src/modules`, migrations/tests.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| High | Clinical backend routes exist but are not mounted in production root. | `apps/backend/src/index.ts:381`-`425` mounts M2/M3/M4/M5/M33/M34/M36/M38/M39/M40 only. | Route code/tests can pass while production host exposes no clinical route surface for these modules. | Progressively mount modules with Drizzle-backed services and boot ABAC predicates. |
| High | Document PHI bundle export lacks step-up despite spec comments. | `apps/backend/src/modules/22-documents/routes/documents-routes.ts:220` preHandler is `[EXPORT, ABAC_OWNER]`; no `requireStepUp`. | High-PHI export can bypass intended ceremony. | Add `requireStepUp("documents.export_phi_bundle")` and audit URL mint/download. |
| High | Signed document URL/access logging incomplete. | `planAccessLog` exists in `apps/backend/src/modules/22-documents/lifecycle/access-log.ts`, but content route/service wiring needs actor/access row enforcement. | Weak accounting of document disclosure/download. | Pass actor/membership/correlation to signed URL service and append access logs/outbox. |
| Medium | Clinical ABAC predicates are mostly test-registered. | Backend subaudit found module predicate registration in tests, not production boot. | Mounting routes later will deny unless boot wiring is added. | Add central clinical predicate registration with Drizzle resolvers. |

#### Drift Risks
Implemented-but-unmounted modules produce false confidence: tests exercise route slices, while production route registration lags.

#### Required Remediation
Use a module mount checklist: Drizzle service, ABAC predicates, read audit, route registration, OpenAPI enrichment, UI contract tests.

### Module: M30 HQRP & Quality

#### Status
WIP / broken if included in current working tree.

#### Files Reviewed
`packages/db/src/schema/quality/*`, `packages/quality/src/lifecycle/*`, `packages/quality/src/repositories/*`, `apps/backend/src/modules/30-quality`, M30 spec/manifest.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| Critical | Repository code references missing schema barrel exports. | `packages/quality/src/repositories/cahps.ts:5`-`7`; root barrel ends at `packages/db/src/schema/index.ts:493`. | Build/typecheck fail. | Export quality only after correcting schema; otherwise remove WIP from build. |
| Critical | M30 package imports violate dependency-cruiser boundary. | `arch:fitness` reports 9 `module-30-boundary` errors. | Fitness/test gate fails. | Adjust architecture or move repository code. |
| High | PHI tables lack required tenancy columns. | `arch:tenancy` names `cahps_decedent_sample`, `infection_surveillance_event`, `incident_report`; evidence in `cahps.ts:20`-`30`, `infection.ts:5`-`12`, `incident.ts:8`-`16`. | PHI isolation non-compliance. | Add `provider_entity_id` and `location_id` per ARCH-011/spec. |
| High | No M30 migrations. | Search in `packages/db/migrations` finds no `incident_report`, `quality_measure_value`, `qapi_program`, `sra_cycle`, etc. | Runtime DB tables/RLS/audit absent. | Add tables migration plus RLS/audit/partition migration. |
| High | CAHPS caregiver data appears plaintext. | `packages/db/src/schema/quality/cahps.ts:28`-`30` uses `primary_caregiver_name/phone/email` text. | PHI at rest risk vs encryption expectations. | Use encrypted cipher columns and key version metadata per spec. |
| Medium | Spec/table count drift. | Manifest and WIP schema have 18 tables; spec text reportedly says 14 and references `risk_register_view`. | Confusing implementation target. | Update spec or manifest with ADR-backed decision. |

#### Drift Risks
Quality depends on many clinical seams. Landing it before DB, seam, migration, and audit conventions are stable will create high cross-module drift.

#### Required Remediation
Make M30 a single coherent landing: spec reconciliation, schema correction, barrel export, migrations, RLS tests, package exports, backend routes, OpenAPI, status matrix.

### Module: M33 Reporting

#### Status
Implemented / production-mounted, with contract gaps.

#### Files Reviewed
`packages/reporting`, `apps/backend/src/modules/33-reporting`, `apps/web/src/modules/33-reporting`, migrations `0056`-`0061`.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| Medium | Web code path missing from manifest. | `apps/web/src/main.tsx` registers `reportingScreens`; manifest lacks `apps/web/src/modules/33-reporting`. | Status matrix false negative and boundary blind spot. | Add manifest code path. |
| Medium | OpenAPI client casts hide schema gaps. | `apps/web/src/modules/33-reporting/*` uses `as never` for query/body parameters. | Compile-time contract safety disabled. | Add OpenAPI enrichments/query schemas and remove casts. |
| Medium | References M15 events before M15 lands. | `packages/reporting/src/catalog/outbox-subscription-map.ts` references `m15.*`. | Reporting freshness remains empty until M15 lands. | Keep documented as forward wiring; add degraded/empty state tests. |

#### Drift Risks
Reporting will amplify contract drift because it aggregates many modules and uses generated clients.

#### Required Remediation
Manifest path, OpenAPI enrichment, and contract tests around reporting reads/drilldowns.

### Module: M34 SaaS Tenant Platform

#### Status
Implemented / production-mounted, partial.

#### Files Reviewed
`packages/saas-tenant-platform`, `apps/backend/src/modules/34-saas-tenant-platform`, `apps/web/src/modules/34-saas`, `packages/admin-ui-shell`, migrations `0050`-`0055`.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| High | Platform bypass auditor throws. | `apps/backend/src/index.ts:253`-`257` and `:400`-`:404`. | Platform cross-tenant reads 5xx. | Bind real M4 audit emitter. |
| High | Admin UI shell unused. | `packages/admin-ui-shell/src/index.ts` exports shell; no `@wardenx/admin-ui-shell` import in `apps/web`. | Platform support-session context UX not active. | Wrap M34 routes with shell or mark deferred. |
| Medium | DSAR/tenant export download metadata incomplete. | Security audit found schema fields not stamped by service. | Weak export accountability. | Stamp URL generation/download actor fields and audit events. |
| Medium | Web code path missing from manifest. | M34 screens registered, manifest lacks web path. | Status matrix false negative. | Add manifest code path. |

#### Drift Risks
M34 has platform-wide authority; any missing audit/bypass/step-up wiring should block production use of cross-tenant surfaces.

#### Required Remediation
Bind bypass audit, integrate admin shell, add export download controls, manifest path.

### Module: M36 Messaging, M38 Terminology, M39 Consent, M40 MDM

#### Status
Implemented / production-mounted.

#### Files Reviewed
`apps/backend/src/modules/36-messaging`, `38-terminology`, `39-consent`, `40-mdm`; corresponding packages/web modules.

#### Findings

| Severity | Finding | Evidence | Impact | Fix |
|----------|---------|----------|--------|-----|
| Critical | ABAC/step-up boot issue affects mounted actions. | `requireAbac` deny-all default and missing `step_up_recent` registration. | Consent sign/revoke, MDM merge, messaging visibility, and reporting/platform gates can deny unexpectedly. | Install ABAC evaluator/predicate. |
| Medium | Realtime provider not wired for messaging. | Frontend audit found `SocketProvider` exists in `packages/ui` but no `apps/web` usage. | Alerts/messages are polling-only. | Mount realtime provider when backend channel is ready. |
| Medium | Some screens lack or need richer permission gating. | Frontend audit named `terminology.admin`, `mdm.console`, notifications/staff cases. | Nav visibility can exceed server permissions. | Add/align `requiredPermission` values and tests. |

#### Drift Risks
Mounted modules can appear live while authorization dependencies remain fail-closed or UI nav remains wider than server policy.

#### Required Remediation
Authorization boot wiring, realtime integration, permission metadata tests.

---

## 6. Backend Findings

### Routing

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| High | `apps/backend/src/index.ts` | Clinical modules M6-M14/M17/M18/M22 have route modules/tests but are not mounted in production. | Mounted list at `apps/backend/src/index.ts:381`-`425` excludes them. | Add progressive mount functions with real stores and boot predicates. |
| High | `apps/backend/src/modules/22-documents/routes/documents-routes.ts` | Export PHI bundle route lacks step-up. | `POST /api/v1/documents/:id/export-phi-bundle` preHandler is `[EXPORT, ABAC_OWNER]`. | Add `requireStepUp("documents.export_phi_bundle")`. |

### Validation

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| Medium | Route modules / OpenAPI scanner | Runtime validation is manual TypeBox parsing and OpenAPI is regex/enrichment based. | `openapi:check` passes, but frontend still uses `as never` casts for missing query/body schemas. | Attach/enrich schemas for all implemented routes and remove casts. |

### Services

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| High | `apps/backend/src/index.ts` | M34 platform service receives throwing bypass auditor. | `m34FailClosedBypassAuditor` throws at `apps/backend/src/index.ts:253`-`257`. | Bind M4 audit bypass implementation. |
| Medium | `apps/backend/src/index.ts` | M4 audit workers are deferred while M33/M34 workers start. | `apps/backend/src/index.ts:442`-`448`. | Start M4 workers with production adapters. |

### Repositories

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| Critical | `packages/quality/src/repositories/*` | Repositories reference unexported M30 schema. | Build/typecheck errors in `cahps.ts`, `incident.ts`, `qapi.ts`, `sra.ts`, etc. | Fix M30 schema barrel or isolate WIP. |
| High | `packages/quality/src/repositories/*` | Repository package import violates M30 boundary. | `arch:boundaries` reports 9 errors. | Update allowed imports intentionally or relocate code. |

### Auth/RBAC

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| Critical | `packages/auth/src/abac/require-abac.ts`, `apps/backend/src/index.ts` | ABAC evaluator default denies and registry is not installed in production boot. | `DENY_ALL_EVALUATOR` at lines 65-66; only test references to `registerAbacRegistry()`. | Call `registerAbacRegistry()` at boot. |
| Critical | `packages/auth/src/abac/require-abac.ts` | Step-up delegates to unregistered predicate. | `requireStepUp()` uses `step_up_recent` at lines 192-195; no registration found. | Register predicate using M2 step-up session state. |
| High | `apps/backend/src/modules/03-authorization` | Break-glass contract is test-only/in-memory. | Backend audit found production mount uses in-memory break-glass/engagements. | Wire Drizzle break-glass and critical audit. |

### Audit Logging

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| High | `packages/audit/src/read/audit-read.ts`, PHI routes | Read-audit helpers exist but are not globally enforced on PHI reads. | Search shows helper definitions and docs, but no boot-wide assertion. | Add middleware/coverage check for PHI read routes. |
| High | `apps/backend/src/modules/22-documents` | Document URL mint/download needs access logging. | `planAccessLog` exists but content route/service wiring is incomplete. | Append `document_access_log` + audit/outbox event on URL mint/download. |

### Error Handling

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| Medium | `apps/backend/src/bootstrap/plugins/error-handler.ts`, `bootstrap/index.ts` | Unhandled error logging lacks global PHI redaction. | Logger has no redaction config. | Sanitize logged errors and request metadata. |

### Environment Config

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| High | `apps/backend/src/index.ts`, `packages/auth/src/identity/auth.ts` | Production env variables are not schema-validated/fail-closed. | Raw `process.env` reads in boot. | Add env validation with strong production requirements. |

### OpenAPI

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| Medium | `scripts/openapi/enrichments.ts`, web screens | OpenAPI file is fresh, but generated types are bypassed with `as never`. | `bun run openapi:check` passed; rg found many casts in M33/M34. | Add missing route query/body/path schemas and remove casts. |

### Integration Boundaries

| Severity | File(s) | Finding | Evidence | Fix |
|---|---|---|---|---|
| Critical | `packages/quality/src/repositories/*` | M30 boundary violations. | `arch:fitness` output. | Fix M30 dependency model. |

---

## 7. Frontend Findings

### Routing

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Critical | `apps/web/src/shell/app.tsx:60`-`70` mounts chromed elements directly inside `AppLayout`. | No route-level auth guard. | Add `ProtectedRoute`/layout guard for chromed routes. |
| Medium | `packages/ui/src/web/components/degraded-banner.tsx` links `/status`; no registered `/status` screen found. | Broken status link. | Register status page or link external status. |

### API Client

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Medium | M33/M34 screens use `as never` for generated client calls. | Type safety suppressed for route params/query/body. | Enrich OpenAPI schemas and remove casts. |

### Forms

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Medium | Forms use manual state/FormEvent patterns; no shared schema-driven form validation found. | High-risk writes rely primarily on server validation. | Add shared form/schema utilities for prescribing/admin/export workflows. |

### Components

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| High | `packages/admin-ui-shell` exports platform shell, but `apps/web` does not consume it. | M34 platform layout/context not active. | Integrate `PlatformOpsShell` for M34 routes. |
| Medium | Patient chart local navigation stale vs built modules. | Inconsistent module navigation from patient workspace. | Use shared chart rail. |

### Auth Guards

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Critical | `apps/web/src/shell/session.tsx:43`-`56`; `actor-session.ts:44`-`50`. | Session has no loading state; permission gating fail-open. | Add session status and fail-closed nav while loading. |

### Role-Based UI

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Medium | Some sensitive screens omit or need better `requiredPermission`, e.g. terminology/MDM/staff cases from frontend audit. | Nav visibility wider than server policy. | Add permission metadata and tests for every sensitive screen. |

### PHI Handling

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| High | `apps/web/src/modules/05-patient/global-search.tsx:52`-`73`. | Recent searches stored in `localStorage`. | Remove PHI storage or encrypt/server-side TTL. |
| High | Patient chart `MaskedIdentifier` path lacks reveal handler per frontend audit. | No audited step-up reveal. | Wire reveal flow to step-up + audit. |

### Accessibility

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Low | Frontend audit found many work queues keyboard-enabled but screen-lock lacks robust focus trap. | Dialog focus handling incomplete. | Add focus trap and escape handling tests. |

### State and Error Handling

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Medium | `/403` exists but feature screens do not route API 403s there. | 401/403/500 often collapse to generic unavailable. | Add shared API error taxonomy and correlation-aware messages. |

---

## 8. Database and Migration Findings

### Schema

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Critical | `packages/db/src/schema/index.ts:465`-`493` ends at docs/saas/reporting; no quality export. | M30 schema unreachable to repositories/Drizzle config. | Add quality export after schema is corrected. |
| High | `packages/db/src/schema/quality/cahps.ts:28`-`30`. | Plaintext CAHPS caregiver contact fields. | Use encrypted columns/key metadata. |

### Migrations

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| High | No M30 table names found in `packages/db/migrations`. | M30 has schema but no tables/RLS/audit in DB. | Add M30 tables + RLS/audit migrations. |
| High | `_journal.json:335`-`340`; SQL files through `0061`. | Drizzle journal stale. | Reconcile metadata or enforce custom migrator only. |

### Enums

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Medium | `incident.ts:6` uses `low/moderate/high/sentinel`; spec reportedly has different variants. | Enum drift risk. | Reconcile spec/schema/lifecycle before migration. |

### Constraints

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Medium | M30 QAPI/SRA schema uses bare UUID relationships per DB audit. | Missing intra-module FKs. | Add FKs where lifecycle requires referential integrity. |

### Indexes

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Info | Existing modules have systematic org/status/date indexes; M30 has some indexes but should be reviewed after schema reconciliation. | Premature to score until M30 model is final. | Add indexes on org/provider/location/date/status filters. |

### Seeds

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| Low | No M30 seed; dev seeds are local-only. | Demo quality data absent. | Add after migrations/routes stabilize. |

### Audit Tables

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| High | M30 no migrations; PHI tables therefore no M4 triggers. | Write audit absent for M30. | Install triggers in M30 RLS/audit migration. |

### PHI Fields

| Severity | Evidence | Gap | Fix |
|---|---|---|---|
| High | `arch:tenancy` failures. | PHI spine missing provider/location columns. | Add ARCH-011 columns. |

---

## 9. API Contract Findings

| Finding Type | Evidence | Impact | Fix |
|---|---|---|---|
| Missing routes from OpenAPI | `openapi:check` reports 532 routes and passes; no freshness issue found. | N/A for freshness. | Keep check in CI. |
| Routes without schemas | Frontend `as never` casts in M33/M34 imply missing query/body/path schemas despite fresh OpenAPI. | Generated client does not fully protect contract. | Add OpenAPI enrichments for M33/M34/M39/M3 route bodies and queries. |
| Schema/handler mismatches | M30 repositories expect DB schema exports that are absent. | Compile-time DB contract broken. | Fix M30 barrel/schema/migrations. |
| Frontend/backend mismatches | Patient chart marks shipped modules as unavailable; admin UI shell unused; some screen permissions missing. | UI can mislead users and fail auth visibility expectations. | Align screens with backend permissions and shipped routes. |
| Error response mismatches | `/403` page exists but feature API denials do not route there. | Users see generic unavailable states. | Add shared API error handler. |

---

## 10. Security, HIPAA, and Privacy Findings

| Severity | Risk | Evidence | HIPAA/Privacy Impact | Fix |
|----------|------|----------|----------------------|-----|
| High | PHI read access not consistently audited. | `auditPhiRead`/`auditListRead` helpers exist; no global route coverage assertion. | Weak HIPAA audit-control and accounting-of-disclosures posture. | Add read-audit middleware/coverage checker. |
| High | PHI in URLs/logs/search storage. | Fastify logger lacks redaction; `global-search.tsx:52`-`73` stores recent terms; search URLs include query strings. | PHI may persist in logs/history/storage. | Redact logs; avoid query-string PHI and localStorage. |
| High | Document export/download controls incomplete. | `documents-routes.ts` export route lacks step-up; access-log plan exists separately. | PHI download accountability and ceremony gaps. | Add step-up and access-log/audit rows on URL mint/download. |
| High | Production auth env does not fail closed. | Raw env reads in boot. | Weak secrets/origins can compromise auth. | Add production env schema. |
| High | Dependency vulnerabilities. | `bun audit` found 1 critical, 2 high, 4 moderate. | Increased compromise risk. | Update dependencies and rerun checks. |
| Medium-High | DSAR export download stamping incomplete. | Security audit found download/generation fields not fully updated. | Weak forensic reconstruction. | Stamp actor/timestamps and audit every URL mint/download. |
| Medium | Rate limiting in-memory. | Security baseline uses local state. | Weak brute-force/abuse control in multi-instance deployments. | Shared Valkey-backed limiter. |
| Medium | Feature flags inert at runtime. | `AppShell` defaults `flags = {}` and no runtime loader found. | Security-sensitive feature gating can drift. | Load server-side tenant/platform flags. |

---

## 11. Testing and QA Findings

| Area | Current State | Gap | Risk | Recommended Test |
|------|---------------|-----|------|------------------|
| Build/typecheck | Failing due M30 missing schema exports. | No green baseline. | CI blocked. | Add M30 landing test or isolate WIP. |
| Fitness gates | Tests fail on tenancy and boundaries. | Root baseline no longer green. | Architecture drift can land. | Keep `scripts/__tests__/fitness-gates.test.ts` and fix violations. |
| RLS live tests | Existing live tests skipped unless DB configured. | M30 lacks live RLS tests. | Tenant isolation regressions. | Add `m30-rls-isolation.live.test.ts`. |
| ABAC boot | Predicate registry mostly tested in slices. | No production boot assertion for ABAC evaluator/step-up. | Guarded routes fail/deny. | Test composition root installs ABAC evaluator and `step_up_recent`. |
| PHI read audit | Helpers tested, route coverage not globally enforced. | Read routes can skip audit. | HIPAA audit gap. | Add route audit coverage test scanning PHI GET/download routes. |
| Frontend route auth | Minimal shell tests. | No protected-route tests. | Unauthenticated route exposure. | Test unauthenticated chromed route redirects to login and loading hides gated nav. |
| API contract | OpenAPI/client freshness pass. | Casts hide missing schema detail. | Runtime drift. | Add failing lint/ts rule or test banning `as never` in API calls unless annotated. |
| Dependency security | `bun audit` fails. | No passing vulnerability baseline. | Known CVEs. | Add CI audit with severity threshold. |

---

## 12. Technical Debt Register

| ID | Debt Item | Area | Severity | Why It Matters | Paydown Strategy |
|----|-----------|------|----------|----------------|------------------|
| TD-001 | M30 WIP crosses compile, boundary, tenancy, status gates before coherent landing. | Quality / DB | Critical | Blocks all core checks. | Land M30 in an ordered PR or isolate WIP. |
| TD-002 | ABAC/step-up production boot wiring is test-local. | Auth | Critical | Guards appear present but deny/fail. | Boot-time registration + tests. |
| TD-003 | PHI read audit coverage is not enforced as a global invariant. | Audit/HIPAA | High | Read/disclosure accounting can be missed. | Route metadata + scanner + middleware. |
| TD-004 | Drizzle journal and SQL migrations have split authority. | DB | High | Future migrations may diverge. | Reconcile metadata or remove ambiguity. |
| TD-005 | Frontend session model lacks loading/authenticated/anonymous states. | Frontend | High | Fail-open nav and no route guard. | Introduce session state machine. |
| TD-006 | OpenAPI client casts bypass generated contract. | API | Medium | Type safety erodes around newest modules. | Enrich schemas and ban casts. |
| TD-007 | Admin UI shell package is unused. | Frontend/M34 | Medium | Implemented package can rot. | Integrate or defer/remove. |
| TD-008 | Stale docs and generated status reports. | Docs/Tooling | Medium | Misleading implementation status. | Refresh docs after module waves. |
| TD-009 | In-memory production fallbacks remain in auth/security/idempotency. | Backend | Medium | Multi-instance behavior unsafe/incomplete. | Replace with DB/Valkey stores. |
| TD-010 | Dependency vulnerability baseline is red. | Supply chain | High | Known CVEs remain. | Update dependencies and enforce audit. |

---

## 13. Remediation Plan

### Phase 0 - Stop-the-Bleed Fixes
Fix build, typecheck, lint, broken imports, unsafe route exposure, and severe security issues.

1. Decide M30 WIP strategy: isolate from build or complete DB barrel/schema/migration/boundary work.
2. Fix `arch:boundaries`, `arch:tenancy`, `arch:status-matrix`, `bun run build`, `bun run typecheck`, and `bun run test`.
3. Add frontend route guard and fail-closed nav while session loads.
4. Add PHI-safe Pino/Fastify redaction and remove PHI search localStorage.
5. Update vulnerable dependencies.

### Phase 1 - Contract and Boundary Stabilization
Stabilize schemas, OpenAPI, module boundaries, shared enums, and route registration.

1. Add M33/M34 web code paths to manifest.
2. Enrich OpenAPI route schemas for M33/M34/M39/M3 and remove `as never` API casts.
3. Add parity check for unmanifested `apps/web/src/modules/*`.
4. Reconcile Drizzle journal or document/enforce custom migrator.

### Phase 2 - Security and HIPAA Hardening
Enforce RBAC, audit logging, PHI-safe logging, environment validation, and data access scoping.

1. Install ABAC evaluator and `step_up_recent` predicate at boot.
2. Wire break-glass contract and critical audit hook.
3. Enforce PHI read-audit coverage.
4. Add production env validation.
5. Complete document/DSAR/export URL audit and step-up controls.

### Phase 3 - Database Integrity
Fix schema drift, migrations, indexes, constraints, enum consistency, and seed reliability.

1. Reconcile M30 spec/schema/table count/risk view/enums.
2. Add M30 provider/location PHI spine, encrypted CAHPS caregiver columns, intra-module FKs.
3. Add M30 tables and RLS/audit migrations.
4. Add M30 live RLS tests and regenerate status matrix.

### Phase 4 - Frontend/API Alignment
Align forms, UI fields, API clients, auth guards, loading states, and error handling.

1. Integrate M34 `PlatformOpsShell`.
2. Fix patient chart navigation and audited identifier reveal.
3. Add shared API error taxonomy for 401/403/404/500.
4. Wire runtime feature flags and realtime messaging provider.

### Phase 5 - Testing and CI Enforcement
Add unit, integration, contract, RBAC, audit, and regression tests. Enforce checks in CI.

1. Add boot tests for ABAC/step-up/break-glass.
2. Add route read-audit coverage scanner.
3. Add frontend protected-route tests.
4. Add dependency audit and secret/PHI-log scans.
5. Add schema/migration journal parity check.

---

## 14. Implementation Plan

| Task ID | Task | Files | Owner Type | Dependencies | Acceptance Criteria |
|--------|------|-------|------------|--------------|---------------------|
| AUDIT-FIX-001 | Choose M30 WIP strategy and restore green baseline. | `packages/quality`, `packages/db/src/schema/quality`, `package.json`, tsconfigs if needed | Backend/DB architect | None | `bun run build`, `bun run typecheck`, and `bun run test` no longer fail on M30 missing exports. |
| AUDIT-FIX-002 | Fix M30 boundary violations. | `architecture/module-manifest.ts`, dependency-cruiser config, `packages/quality/src/repositories/*` | Architecture owner | AUDIT-FIX-001 | `bun run arch:boundaries` passes. |
| AUDIT-FIX-003 | Fix M30 PHI tenancy columns. | `packages/db/src/schema/quality/cahps.ts`, `incident.ts`, `infection.ts`, related files | DB architect | AUDIT-FIX-001 | `bun run arch:tenancy` passes with quality schema present. |
| AUDIT-FIX-004 | Install ABAC evaluator and `step_up_recent` predicate at boot. | `apps/backend/src/index.ts`, `packages/auth/src/abac`, M2 step-up resolver | Auth engineer | None | Production boot test shows `requireAbac` uses registry and step-up predicate allows/denies based on session recency. |
| AUDIT-FIX-005 | Wire break-glass contract. | `apps/backend/src/modules/03-authorization`, `apps/backend/src/index.ts`, `packages/audit` | Auth/compliance engineer | AUDIT-FIX-004 | Break-glass route test passes with critical audit event emitted. |
| AUDIT-FIX-006 | Add PHI-safe logging. | `apps/backend/src/bootstrap/index.ts`, logging plugin | Security engineer | None | Requests with PHI-like query/body fields do not log raw values in tests. |
| AUDIT-FIX-007 | Remove PHI localStorage search recents. | `apps/web/src/modules/05-patient/global-search.tsx` | Frontend engineer | None | Search terms are not written to `localStorage`; test covers no persistent PHI. |
| AUDIT-FIX-008 | Add protected frontend routes and session status. | `apps/web/src/shell/app.tsx`, `session.tsx`, `actor-session.ts`, tests | Frontend engineer | None | Anonymous chromed route redirects; loading state hides gated nav. |
| AUDIT-FIX-009 | Enforce PHI read audit. | `packages/audit`, `apps/backend/src/modules/*` PHI routes, scanner tests | Compliance/backend engineer | AUDIT-FIX-004 | Scanner/test fails if PHI GET/download route lacks read-audit metadata/call. |
| AUDIT-FIX-010 | Add document export step-up/access logging. | `apps/backend/src/modules/22-documents/routes/*`, `lifecycle/access-log.ts` | Backend engineer | AUDIT-FIX-004, AUDIT-FIX-009 | PHI bundle export requires step-up; signed URL mint writes access log. |
| AUDIT-FIX-011 | Reconcile migration journal or enforce custom migrator. | `packages/db/migrations/meta/*`, `scripts/db/migrate.ts`, docs | DB/tooling engineer | None | CI check confirms migration authority; no journal/SQL drift warning remains. |
| AUDIT-FIX-012 | Add M33/M34 web code paths to manifest. | `architecture/module-manifest.ts`, generated reports | Architecture/frontend engineer | None | `bun run arch:status-matrix` reports accurate screen status and passes. |
| AUDIT-FIX-013 | Enrich OpenAPI and remove `as never` casts. | `scripts/openapi/enrichments.ts`, M33/M34 route schemas, web screens | API/frontend engineer | AUDIT-FIX-012 | `rg "as never" apps/web/src/modules/33-reporting apps/web/src/modules/34-saas` returns no API-client bypasses. |
| AUDIT-FIX-014 | Integrate M34 admin UI shell. | `apps/web/src/modules/34-saas`, `apps/web/package.json`, `packages/admin-ui-shell` | Frontend engineer | AUDIT-FIX-012 | Platform ops routes render with `PlatformOpsShell` and support-session banner test passes. |
| AUDIT-FIX-015 | Update vulnerable dependencies. | `package.json`, `bun.lock` | Platform engineer | Green build baseline preferred | `bun audit` has no critical/high findings or approved exceptions. |

---

## 15. Suggested Code Changes

```ts
// apps/backend/src/index.ts
// After all register*AbacPredicates() calls in wireModuleSeams():
import { createPredicateRegistry, registerAbacRegistry, registerPredicate } from "@wardenx/auth";

export function wireModuleSeams(deps: { sessionContextStore?: SessionContextStore; db?: DbClient } = {}): void {
  // existing seam + predicate registration...
  registerConsentAbacPredicates();
  registerM33AbacPredicates();
  registerTenantPlatformAbacPredicates({ resolver: SLICE_M34_ABAC_RESOLVER });

  registerPredicate("step_up_recent", async (context, target) => {
    const operationKey = String(target.operationKey ?? "");
    const session = await getSeam("SessionContextResolver").resolve(context.sessionId);
    return stepUpSatisfies(session, operationKey);
  });

  registerAbacRegistry();
}
```

```tsx
// apps/web/src/shell/session.tsx
export type SessionStatus =
  | { state: "loading"; session: null }
  | { state: "anonymous"; session: null }
  | { state: "authenticated"; session: Session };

// Use this state in AppShell route guards and make canSeeScreen fail closed while loading/anonymous.
```

```tsx
// apps/web/src/shell/app.tsx
function ProtectedChrome({ children }: { children: ReactNode }) {
  const { state } = useSessionStatus();
  if (state === "loading") return <LoadingSpinner label="Loading workspace" />;
  if (state === "anonymous") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

```ts
// apps/web/src/modules/05-patient/global-search.tsx
// Replace persistent recents with process-memory recents or remove recents entirely for PHI search terms.
const recentTerms = new Set<string>();
function pushRecent(term: string): string[] {
  recentTerms.delete(term);
  recentTerms.add(term);
  return Array.from(recentTerms).slice(-6).reverse();
}
```

```ts
// packages/db/src/schema/index.ts
// Only after M30 schema is reconciled and migrations exist:
export * from "./quality/index";
```

```sql
-- packages/db/migrations/0063_quality_m30_rls_audit_triggers.sql
ALTER TABLE incident_report ENABLE ROW LEVEL SECURITY;
CREATE POLICY incident_report_org_isolation ON incident_report
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);

CREATE TRIGGER trg_audit_incident_report_phi_write
  AFTER INSERT OR UPDATE OR DELETE ON incident_report
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_incident_report();
```

---

## 16. CI / Fitness Checks To Add

| Check | Recommendation |
|---|---|
| Typecheck | Keep `bun run typecheck` mandatory; add package-level isolation for WIP modules if needed. |
| Lint | Keep `bun run lint`; optionally add `format:check` alias for prompt/tool compatibility. |
| Tests | Keep `bun run test`; add production boot tests for ABAC/step-up/break-glass. |
| OpenAPI generation diff check | Keep `openapi:check` and `client:check`; add a ban/review gate for `as never` API client casts. |
| Database migration check | Add migration SQL vs Drizzle journal parity, or explicitly check custom migrator file list. |
| Module boundary check | Extend `arch:parity` to detect unmanifested `apps/web/src/modules/*`. |
| Dependency audit | Add `bun audit` with severity threshold and exception file. |
| Secret scan | Add gitleaks/trufflehog or equivalent to CI/pre-push. |
| PHI log scan | Add tests for logger redaction and disallow PHI query logging. |
| RBAC coverage check | Assert every non-public route has `requirePermission`, `requireAbac`, or documented public exemption. |
| Route schema coverage check | Assert implemented routes have request/response schema metadata/enrichment. |
| Read audit coverage check | Assert every PHI GET/download/export route has read-audit declaration/call. |
| M30 schema/migration coverage | Hard-fail manifest-owned tables with Drizzle schema but no migration/RLS/audit trigger. |

---

## 17. Final Verdict

The current codebase is safe to continue building on only after the present WIP blockers are resolved. The architecture fitness kit is doing valuable work: it caught M30 boundary and tenancy drift quickly, and the generated reports expose stale implementation state. The foundation should be kept; no rewrite is warranted.

Before adding more modules, fix the green-baseline blockers (`build`, `typecheck`, `test`, `arch:fitness`), production auth/ABAC/step-up wiring, PHI-safe logging/search storage, and PHI read-audit enforcement. These are cross-cutting controls that every future hospice/EHR module will rely on.

Work that can proceed in parallel: dependency updates, M33/M34 manifest paths, OpenAPI enrichment, admin UI shell integration, frontend route guards, and migration metadata reconciliation.

Work that should be deferred until the baseline is green: landing M30 routes/UI, adding more quality measures, expanding portal features, and mounting additional clinical routes without the ABAC/read-audit/PHI logging controls in place.
