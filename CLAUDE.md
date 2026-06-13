# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness
kit** (no application source yet). Use this guide to locate authoritative documents.

## Document map

### Module specifications → `docs/modules/`
**All 40 module specs live in [`docs/modules/`](./docs/modules/).** Start at the index:
[`docs/modules/README.md`](./docs/modules/README.md) — every module, its version, and a link.
The Module 29 forward-engineering sub-tasks (T-29.01–T-29.13) are in
[`docs/modules/module-29-tasks/`](./docs/modules/module-29-tasks/).

> When you need a module spec, **resolve it under `docs/modules/`**, not the repo root.

### UI screen specifications → `docs/ui/`
The UI screen specs (core/app-shell, clinical, revenue, admin, portal, platform/ops) live under
[`docs/ui/screens/`](./docs/ui/screens/), indexed by
[`docs/ui/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`](./docs/ui/WARDENX_UI_COMPLETE_SCREEN_INDEX.md).
Every spec declares a named layout pattern (`Use <name>.`) defined in
[`docs/ui/WARDENX_UI_LAYOUT_PATTERNS.md`](./docs/ui/WARDENX_UI_LAYOUT_PATTERNS.md) — the
authoritative glossary of layout patterns, shared regions, and composition rules. Like module
specs, **UI screen specs are implementation proposals** (architecture wins on conflict).

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

### Architecture-fitness kit (code — `architecture/`, not `docs/architecture/`)
Note: the `architecture/` directory at the repo root holds the *enforcement code*, distinct from
the prose docs in `docs/architecture/`.
- `architecture/module-manifest.ts` (+ `.cjs`) — single source of truth for each module's
  `codePaths`, `dependsOn`, and `ownedTables` (451 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-tenancy.ts`, `check-ddl-legality.ts` — enforced via
  `package.json` scripts (`bun run arch:fitness`).

### Governance & history
- `docs/adr/` — Architecture Decision Records (ADR-0001…).
- `docs/reviews/` — audit/review prompt templates.
- `docs/REMEDIATION_SUMMARY.md`, `audit/` — point-in-time audit reports. These reference module
  specs **by filename**; resolve those filenames under `docs/modules/`.

## Authority rule
Architecture documents are authoritative. Module specifications are implementation proposals.
**If a module conflicts with architecture, architecture wins.**
