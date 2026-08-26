# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness
kit + staged implementation monorepo**: Phase 0 gates/scaffold are in place, and **all 40 modules
now have real implementation on `main`** — the clinical core (M1–M14, M17, M18, M22), the field/ops
tier (M15 Discipline Plans · M16 Bereavement · M19 On-Call Triage · M20 Field Safety · M21 Supplies/DME),
the **complete revenue cycle (M23 Billing-Medicare · M24 Billing-Medicaid · M25 Remittance & Denials ·
M26 Cap Management · M27 Cost Report)**, **M28 FHIR Gateway**, **M29 External Interfaces**,
**M30 HQRP & Quality**, **M31 Patient/Family Portal & Telehealth**, **M32 AI Platform**, M33 Reporting,
M34 SaaS Platform, **M35 Subscription Billing**, **M37 Inpatient Unit (IPU) Management**, plus the
platform services M36/M38/M39/M40. The generated **implementation-status matrix**
(`bun run status:matrix` → `audit/implementation-status/IMPLEMENTATION_STATUS.md`) is the per-module
truth — currently **🟢 40 · 🟡 0 · ⚪ 0** (the module set is complete; the last three placeholders —
M29, M35, and M37 — are now merged). Every module is enrichment-complete (matrix `Enriched`
full-ratio ✅, corpus 1219/1226 routes carry request/response contracts —
`audit/openapi-coverage/OPENAPI_COVERAGE.md` is the generated, authoritative count; re-check there
before citing a number here, since this line is hand-maintained prose and the generated report is
not). The `Live` column (cross-tenant RLS proof) is also full-ratio ✅ across all 40 modules,
including the three newest — **M29 (11/11), M35 (21/21), M37 (26/26)** — whose live-RLS suites
completed in the Phase 0-2 remediation pass. **M30 is merged (PR #106)**: 18 frozen
`quality/` tables + migrations 0062–0068; the `@wardenx/quality` domain core + `@wardenx/cahps-vendors`;
60 routes in `apps/backend/src/modules/30-quality`; the `MEASURE_CATALOG`/measure registry (HCI 10
indicators + composite, HVLDL, HOPE-derived TFP, operational); and CAHPS/QAPI/SRA/incident/mortality/
infection surveillance — status matrix 🟢. A follow-up wiring batch (**issue #107, PRs #108–#118**) then
made M30's cross-module seams real: the M1-T10 transactional outbox-row emit (M30+M33 events emit), the
M40-free provider-entity resolver, the M33 `MetricsProvider` registration, the HOPE-rollup + HVLDL measure
inputs (computing end-to-end, incl. a new M6 `DeathDischargeReader` + a Drizzle-backed M8
`SignedEncountersReader`), per-job `withOrgContext` RLS on the recompute/outbreak workers, and the cron
allowlist + active-org enumerator. M23 and M27 are now **merged** (no longer placeholders); the M23/M26→M27
forward-seam binds for the CMS-1984-14 cap calc (`CapAccrualReader` et al.) and M27's own forward seam into
M30 (`CostReportFilingStatusReader`) are **live and tested**, not deny-stubs (`m30-forward-seam-binds.test.ts`,
`m26-cost-report-cap-seam.live.test.ts`, `m27-validation-context.live.test.ts`) — this un-suppresses the CoP
418.310 failure-to-file indicator and half of HCI 5/6/7's inputs. **`hci_composite`'s real remaining blocker
is DATA, not wiring**: 9 of its 10 indicators need M6/M8 aggregate seams
(per-election-period LOC-days, discharge timing, cross-setting transition sequences, per-day
skilled-nursing minutes) that were never built — only `hci_indicator_10` computes. All 10 of the
remaining operational measures are now bound, including `bereavement_coverage_rate` (M16) and the two
that needed an M15 producer-side fix first — `volunteer_compliance_gate_rate` /
`supervisory_visit_on_time` used to return a pre-divided rate (no denominator, so CMS small-N suppression
couldn't apply); M15's `DisciplineComplianceProvider` now exposes the count pair beside each rate method
(`supervisoryOnTimeCounts`/`volunteerGateComplianceCounts`), the same store round-trip, no new query.
`opioid_on_admission_rate` remains genuinely blocked — it needs an M38 RxCUI→therapeutic-class capability
that doesn't exist yet.

The **2026-06-27 security/compliance audit remediation is merged** (PRs #103/#104, see
[`audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md`](./audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md)):
production ABAC-evaluator + `step_up_recent` boot wiring; PHI-safe Fastify logging + no PHI in
browser storage; chromed-route auth guard with fail-closed nav; a fail-closed **PHI read-audit
coverage gate** (`apps/backend/src/bootstrap/plugins/read-audit.ts`) + request-time emission;
fail-closed **production env validation** (`apps/backend/src/bootstrap/env.ts`); the real M34
`platform.bypass_invoked` auditor; **durable break-glass persistence** (Drizzle store + live §2.2
branch); and dependency-vuln bumps (`bun audit` 7→1, drizzle-orm SQL-injection fix).
Use this guide to locate authoritative documents.

> **Building/extending the code?** Start at [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
> (runbook + "how to add a module") and [`docs/PHASE_0_SCAFFOLD_PLAN.md`](./docs/PHASE_0_SCAFFOLD_PLAN.md).
> One-time: `bun install && bun run build && bun run arch:fitness && bun run test` (all green).
> The `apps/`+`packages/` tree is **generated from the manifest** via `bun run scaffold`; the
> `arch:parity` gate keeps tree↔manifest 1:1. See [ADR-0027](./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Document map

> **Single entry point:** [`docs/README.md`](./docs/README.md) is the master index of every
> document under `docs/` — architecture, module specs, design/UI corpus, ADRs, the AI capability
> catalog, roadmap, wave plans, and reference sources — each linked to its canonical location.
> The sections below call out the load-bearing directories.

### Module specifications → `docs/modules/`

**All 40 module specs live in [`docs/modules/`](./docs/modules/).** Start at the index:
[`docs/modules/README.md`](./docs/modules/README.md) — every module, its version, and a link.
The Module 29 forward-engineering sub-tasks are in
[`docs/modules/module-29-tasks/`](./docs/modules/module-29-tasks/) — 12 files spanning
T-29.01–T-29.13 (tasks 12 and 13 share one file, `WARDENX_T-29.12_13_FRONTEND.md`).

> When you need a module spec, **resolve it under `docs/modules/`**, not the repo root.

### UI screen specifications → `docs/design/`

The UI screen specs (core/app-shell, clinical, revenue, admin, portal, platform/ops) live under
[`docs/design/screens/`](./docs/design/screens/), indexed by
[`docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`](./docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md).
Every spec declares a named layout pattern (`Use <name>.`) defined in
[`docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`](./docs/design/WARDENX_UI_LAYOUT_PATTERNS.md) — the
authoritative glossary of layout patterns, shared regions, and composition rules. Like module
specs, **UI screen specs are implementation proposals** (architecture wins on conflict).
Run `bun run docs:ui` (`scripts/check-ui-screens.ts`) to verify corpus consistency —
index parity, layout-heading hygiene, pattern resolution against the glossary, and (2026-08-14)
corpus-wide ADR-citation + relative-link integrity including the root docs.

### Authoritative architecture documents → `docs/architecture/`

These **win over module specs** in any conflict (module specs are implementation proposals).
All live in [`docs/architecture/`](./docs/architecture/):

- `WARDENX_ARCHITECTURE_v0_11.md` — system architecture (authoritative)
- `WARDENX_SYSTEM_DESIGN_v0.3.md`
- `WARDENX_SECURITY_HARDENING_v0_2.md`
- `WARDENX_AI_GOVERNANCE_v0.2.md`
- `WARDENX_DR_BCP_v0.1.md`, `WARDENX_OPS_RUNBOOK_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`
- `ARCHITECTURE_25_15_FITNESS.md` — architecture-fitness rules

> When you need an architecture document, **resolve it under `docs/architecture/`**, not the repo
> root. (Older docs reference these by bare filename or version — same files, new location.)

### Architecture-fitness kit (enforcement code under the repo-root `architecture/`)

Note: the `architecture/` directory at the repo root holds the *enforcement code*, distinct from
the prose docs in `docs/architecture/`.

- `architecture/module-manifest.ts` (+ `.cjs`) — single source of truth for each module's
  `codePaths`, `dependsOn`, and `ownedTables` (460 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-ddl-legality.ts`,
  `check-fitness-gaps.ts` (event-catalog `mN.` convention, seam-registry completeness, PHI
  RLS/audit-trigger presence — armed-inert until app source lands), `check-ui-screens.ts` —
  enforced via `package.json` scripts (`bun run arch:fitness`; UI-corpus check also standalone
  as `bun run docs:ui`).
- `scripts/check-tenancy.ts` — **tenancy & RLS invariants** (`bun run arch:tenancy`, in
  `arch:fitness`): the three-column rule, the canonical `app.org_id` session variable, and the
  dangerous policy shapes ADR-0010 D3 bans. Its Rule 2 exemptions — M4 audit attribution, the M34
  key-ring SECURITY DEFINER GUCs — are scoped to the **statement** they were written for and never
  reach a policy predicate. They used to be tested against the whole FILE, and the repo's own
  convention puts a module's RLS policies in the same migration as its audit triggers
  (`*_rls_audit_triggers.sql`), so one `INSERT INTO audit_event` exempted every `app.user_id` in the
  file — policy bodies included. That is how `user_notif_pref_self` (#21: an org-unscoped `FOR ALL`
  policy on an org-scoped table, a confirmed cross-tenant read AND write) sat green in `0017` while
  the gate reported only the two migrations that happened not to contain a trigger. Policy
  predicates are now judged on the migrations' **net effect** — the files replayed in apply order,
  so a violation a later migration drops and replaces stops counting, which is what lets a
  remediated policy go green without the offending text ever leaving its original file. Deliberately
  a static replay and not a `pg_policies` read: `arch:fitness` runs where there is no database (the
  same reason the live suites are `skipIf`-guarded), so a catalog-reading gate would skip in CI —
  `m1-rls-isolation.live.test.ts` is the catalog-side complement and runs in `rls-live`. A policy
  created through dynamic SQL inside a `DO` block is the known limit, and the plain text scan still
  sees the session variables inside it.
- `scripts/check-abac-predicates.ts` — **ABAC named-predicate resolution** (`bun run arch:abac-predicates`). Every `requireAbac(_, "<name>")` — including through each module's
  local `guards.ts` factory — must name a predicate some module declares. M3's registry fails
  closed on an unknown name, so a typo'd or never-registered name is a permanently dead endpoint
  (403 for every caller) with the whole build green; that is exactly how M30's 15 `inOrg` guards
  sat unreachable across 7 route files. There is **no deferral allowlist**: a predicate whose
  inputs do not exist yet is expressed as a *registered* predicate that denies and says why
  (`deviceAttestationValid` in `packages/auth/src/abac/registry.ts`), never as an unregistered
  name — both refuse identically, only the first is distinguishable from a mistake.
- `scripts/check-live-suite-coverage.ts` — **live-suite CI coverage** (`bun run arch:live-suites`).
  Every `test:m<N>:…:live` script in `package.json` must be invoked by a job in
  `.github/workflows/ci.yml`. A live suite is `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`, so
  with no database it reports SKIPPED rather than failed and `bun run test` stays green either
  way; a script in `package.json` looks wired but nothing distinguishes one CI runs from one
  nothing has ever run. That pairing (GAP-086) left the 25 clinical-core **lifecycle** suites —
  205 assertions over the real Drizzle write paths — unexecuted outside their authors' laptops,
  and 23 of 25 were red once run. Two CI jobs now cover them: `rls-live` (table-level policy
  proof) and `lifecycle-live` (the production route services as the NOBYPASSRLS `wardenx_app`
  role, grouped per module).
- `scripts/check-architecture-docs.ts` — **architecture-corpus freshness gate**
  (`bun run arch:architecture-docs`, in `arch:fitness` since 2026-08-14). The authority rule makes
  `docs/architecture/` binding, yet it was the only ungated documentation body and drifted for two
  months (63 dead cited paths, stale companion citations — see
  `audit/ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`). Enforces: cited repo paths exist
  (paths on a line that says they don't exist are exempt — documented absence is correct), version
  headers parse (filename-version drift needs the "FILENAME still reads" note), `Companion to:`
  citations match on-disk header versions, and four-digit `ADR-NNNN` citations resolve
  (ARCHITECTURE §21's short `ADR-00N` open-decision register is a separate, deliberately ungated
  namespace). Warn-only `<!-- verified-against: sha · date -->` staleness stamps. The six build
  divergences the 2026-08-13 audit surfaced are recorded as ADR-0036…0040 (+ ADR-0030/0032/0035
  for the frontend stack).
- `scripts/check-module-docs.ts` — **module-spec corpus gate** (`bun run arch:module-docs`, in
  `arch:fitness`). Different contract from the architecture gate because specs are PROPOSALS:
  no cited-path rule (planned paths are legal); enforces index parity (40 rows ↔ 40 files),
  the **re-lock-in-place versioning convention** (filename version is pinned; the HEADER is
  authoritative and the index "Spec ver" column must track it — it sat 1–2 re-locks stale for
  26 of 40 modules before this gate), four-digit ADR-citation resolution (audit-era
  "ADR-NNNN / ARCH-nnn" composite citations exempt as a historical namespace), relative-link
  integrity, and the "implementation proposal" authority marker every spec now carries.
- `scripts/check-adr-docs.ts` — **ADR corpus gate** (`bun run arch:adr-docs`, in `arch:fitness`).
  ADRs are immutable once Accepted, so this never checks prose freshness — it checks the corpus as
  a decision REGISTER: contiguous unique numbering 0001…max, index parity, a parseable Status line
  (Accepted/Proposed/Superseded/Rejected/Deprecated; Superseded must cite its successor), the
  index row's status cell AGREEING with the file (a decision must not sit formally Proposed while
  the register calls it Accepted), cross-citations and links resolving. Code-vs-Decision
  compliance is the audit layer (audit/ADR_COMPLIANCE_AUDIT_*.md), not this gate.
- `scripts/audit-fitness.ts` — point-in-time enforcement audit (module matrix, table
  ownership, dependency graph/cycles); writes `audit/FITNESS_ENFORCEMENT_AUDIT.md`.
- `scripts/report-implementation-status.ts` — per-module **implementation-status matrix**
  (spec/schema/migration/routes/screens/tests/adapter per module). A green `arch:fitness`
  proves architecture coherence, NOT feature-completeness — this advisory report shows build
  progress. Regenerate with `bun run status:matrix`; `arch:fitness` runs it in `--check` mode
  (`arch:status-matrix`) to keep `audit/implementation-status/` fresh and to hard-fail on orphan
  (unowned) schema/migration tables. Writes `audit/implementation-status/IMPLEMENTATION_STATUS.md` (+ `.json`).
  The **`Enriched` column is a ratio** (`n/m`), joined route-by-route against the enrichment
  registry — it used to be a per-module boolean that flipped ✅ on a single entry anywhere in the
  module (M06 once sat at 6-of-46 showing ✅). As of the **2026-08-01 enrichment sweep every 🟢
  *feature* module reads a full-ratio ✅** (0 unenriched routes; M01 Foundation reads ❌ because it
  owns tables but no feature routes). The **`Live` column** (owned tables named in a
  `*.live.test.ts`) is likewise full-ratio ✅ for every 🟢 module now — **20 modules carry executed
  cross-tenant RLS suites** (M1–M14, M17, M18, M22, M27, M34, M36, M38, M39, M40, plus M4/M5/M7/
  M15/M16/M19–M21/M23–M26/M30/M32/M33). Both columns are advisory; `arch:openapi-coverage` is what
  fails the build.
- `scripts/report-openapi-coverage.ts` — **OpenAPI enrichment-coverage report + ratchet**
  (`bun run openapi:coverage`; `arch:openapi-coverage` runs `--check`). `openapi:check` proves
  openapi.json was *regenerated* and that no enrichment targets a dead route — it says nothing
  about the reverse, so an **unenriched route is legal** and a routes task can ship 30+ routes
  carrying zero request contracts with every gate green (this is what M20-T06 did). The emitted
  contract does not look absent, it looks *satisfied*: `emit.ts` still writes those routes with
  `parameters: []`, no `requestBody`, and a bare `200: OK`, and `client:gen` types their bodies
  as `never`. This gate ratchets, per module, the count of routes with **no** enrichment entry
  against `audit/openapi-coverage/baseline.json`: the deficit may never **rise** (new routes must
  ship their contracts), and when it **falls** the baseline must be re-tightened
  (`bun run openapi:coverage --update`) so progress is locked in. A module absent from the
  baseline has an implied floor of **0** — a brand-new module's first unenriched route fails.
  The 2026-08-01 sweep retro-enriched the corpus from **478 unenriched → 6** (currently **1219/1226
  enriched**; only bootstrap's health/infra routes remain unenriched) and re-tightened the baseline — the gate
  never *required* that backfill, but the progress is now locked in. Writes
  `audit/openapi-coverage/OPENAPI_COVERAGE.md` (+ `.json`).
  `client:check` (generated typed client ↔ openapi.json) is now in `arch:fitness` too.
- `scripts/report-ui-parity.ts` — **UI implementation-parity report**: bridges the documented
  screen-spec corpus (`docs/design`) and the implemented web surface (registered `screens.ts`), so a
  green `docs:ui` is not mistaken for "the UI is built". Regenerate with `bun run ui:parity`;
  `arch:fitness` runs it in `--check` mode (`arch:ui-parity`) to keep `audit/ui-parity/` fresh and
  to hard-fail on duplicate screen id/path, an unknown `requiredPermission`, or a `screens.ts` not
  wired into `main.tsx`. Writes `audit/ui-parity/UI_PARITY.md` (+ `.json`).
- `scripts/report-frame-fidelity.ts` — **frame-fidelity report**: tracks how far each *built* screen
  has been visually matched to its Pencil frame — the layout-fidelity gap the R0/R1 Lantern
  reconciliation left open (it matched the design *language*, not each screen's *composition*). The
  hand-maintained `scripts/frame-fidelity/registry.ts` maps a built screen → its `SCREENS.md` frame
  node → status (`pending`/`partial`/`matched`); the process is in
  `docs/design/FRAME_FIDELITY_PLAYBOOK.md`. Regenerate with `bun run frame:fidelity`; `arch:fitness`
  runs `--check` mode (`arch:frame-fidelity`) to keep `audit/frame-fidelity/` fresh and to hard-fail
  on an unknown frame node, a duplicate mapping, or a dangling screen id. Writes
  `audit/frame-fidelity/FRAME_FIDELITY.md` (+ `.json`).

### Governance & history

- `docs/adr/` — Architecture Decision Records (ADR-0001…).
- `docs/reviews/` — audit/review prompt templates.
- `docs/REMEDIATION_SUMMARY.md`, `audit/` — point-in-time audit reports. These reference module
  specs **by filename**; resolve those filenames under `docs/modules/`. The latest external review is
  `audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md`; its findings are remediated and merged (PRs #103/#104).

## Authority rule

Architecture documents are authoritative. Module and UI screen specifications are
implementation proposals.
**If a module or screen spec conflicts with architecture, architecture wins.**
