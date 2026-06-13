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

### Authoritative architecture documents (repo root)
These **win over module specs** in any conflict (module specs are implementation proposals):
- `WARDENX_ARCHITECTURE_v0_11.md` — system architecture (authoritative)
- `WARDENX_SYSTEM_DESIGN_v0.3.md`
- `WARDENX_SECURITY_HARDENING_v0_2.md`
- `WARDENX_AI_GOVERNANCE_v0.2.md`
- `WARDENX_DR_BCP_v0.1.md`, `WARDENX_OPS_RUNBOOK_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`
- `ARCHITECTURE_25_15_FITNESS.md` — architecture-fitness rules

### Architecture-fitness kit
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
