# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness
kit + staged implementation monorepo**: Phase 0 gates/scaffold are in place, and **23 of 40 modules
now have real implementation on `main`** — M2–M14, M17, M18, M22 (clinical), **M30 HQRP & Quality**,
M33 Reporting & M34 SaaS Platform (R2), plus M36/M38/M39/M40. **M30 is merged (PR #106)**: 18 frozen
`quality/` tables + migrations 0062–0068; the `@wardenx/quality` domain core + `@wardenx/cahps-vendors`;
47 routes in `apps/backend/src/modules/30-quality`; the `MEASURE_CATALOG`/measure registry (HCI 10
indicators + composite, HVLDL, HOPE-derived TFP, operational); and CAHPS/QAPI/SRA/incident/mortality/
infection surveillance — status matrix 🟢. A follow-up wiring batch (**issue #107, PRs #108–#118**) then
made M30's cross-module seams real: the M1-T10 transactional outbox-row emit (M30+M33 events emit), the
M40-free provider-entity resolver, the M33 `MetricsProvider` registration, the HOPE-rollup + HVLDL measure
inputs (computing end-to-end, incl. a new M6 `DeathDischargeReader` + a Drizzle-backed M8
`SignedEncountersReader`), per-job `withOrgContext` RLS on the recompute/outbreak workers, and the cron
allowlist + active-org enumerator. The **HCI/operational measure families stay fail-closed** — they depend
on the **M23 (Billing) / M27 (Cost Report) placeholder modules**, so `hci_composite` cannot compute until
those land. Remaining modules stay explicit placeholders until their plans land.

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
index parity, layout-heading hygiene, and pattern resolution against the glossary.

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
  `codePaths`, `dependsOn`, and `ownedTables` (453 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-tenancy.ts`, `check-ddl-legality.ts`,
  `check-fitness-gaps.ts` (event-catalog `mN.` convention, seam-registry completeness, PHI
  RLS/audit-trigger presence — armed-inert until app source lands), `check-ui-screens.ts` —
  enforced via `package.json` scripts (`bun run arch:fitness`; UI-corpus check also standalone
  as `bun run docs:ui`).
- `scripts/audit-fitness.ts` — point-in-time enforcement audit (module matrix, table
  ownership, dependency graph/cycles); writes `audit/FITNESS_ENFORCEMENT_AUDIT.md`.
- `scripts/report-implementation-status.ts` — per-module **implementation-status matrix**
  (spec/schema/migration/routes/screens/tests/adapter per module). A green `arch:fitness`
  proves architecture coherence, NOT feature-completeness — this advisory report shows build
  progress. Regenerate with `bun run status:matrix`; `arch:fitness` runs it in `--check` mode
  (`arch:status-matrix`) to keep `audit/implementation-status/` fresh and to hard-fail on orphan
  (unowned) schema/migration tables. Writes `audit/implementation-status/IMPLEMENTATION_STATUS.md` (+ `.json`).
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
