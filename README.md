# WardenX

**Multi-tenant hospice EHR SaaS** — a specification corpus, architecture-fitness kit, and
staged-implementation monorepo. All **40 modules** are implemented on `main`
(status matrix: **🟢 40 · 🟡 0 · ⚪ 0**), spanning the clinical core, field/ops tier, the full
revenue cycle, interoperability (FHIR / external interfaces), quality (HQRP), the patient portal,
the AI platform, and the SaaS/subscription platform.

> Per-module build truth is the generated matrix — `bun run status:matrix` →
> [`audit/implementation-status/IMPLEMENTATION_STATUS.md`](./audit/implementation-status/IMPLEMENTATION_STATUS.md).

## Where to start

| You want to… | Go to |
|---|---|
| **Understand the repo & its authority rules** | [`CLAUDE.md`](./CLAUDE.md) — the repository guide (mirrored as [`AGENTS.md`](./AGENTS.md)). |
| **Find any document** | [`docs/README.md`](./docs/README.md) — the master index of everything under `docs/`. |
| **Run the project locally** | [`docs/START_PROJECT.md`](./docs/START_PROJECT.md) — step-by-step local startup guide. |
| **Build or extend a module** | [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — runbook + "how to add a module". |
| **Read the authoritative architecture** | [`docs/architecture/`](./docs/architecture/) (architecture wins over specs). |
| **Read a module spec** | [`docs/modules/README.md`](./docs/modules/README.md) (40 specs). |
| **Read the design / UI corpus** | [`docs/design/README.md`](./docs/design/README.md) (Lantern system + 113 screen specs). |
| **See decision records** | [`docs/adr/README.md`](./docs/adr/README.md) (ADR-0001…ADR-0035). |

## Quick start

```bash
bun install
bun run build
bun run arch:fitness   # all architecture-fitness gates
bun run test
```

The `apps/` + `packages/` tree is **generated from the manifest** (`architecture/module-manifest.ts`)
via `bun run scaffold`; the `arch:parity` gate keeps tree ↔ manifest 1:1
(see [ADR-0027](./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md)). To run the app locally,
follow [`docs/START_PROJECT.md`](./docs/START_PROJECT.md).

## Authority rule

Architecture documents are **authoritative**; module and UI screen specifications are
**implementation proposals**. If a module or screen spec conflicts with architecture,
**architecture wins**. See [`CLAUDE.md`](./CLAUDE.md) for the full guide.

## Repository layout

| Path | Contents |
|---|---|
| [`docs/`](./docs/) | Specification corpus — architecture, module specs, design/UI, ADRs, plans, reference. See [`docs/README.md`](./docs/README.md). |
| `apps/` · `packages/` | Generated implementation tree (backend, web/portal/admin, domain + shared packages). |
| [`architecture/`](./architecture/) | Architecture-fitness **enforcement code** (manifest, dependency-cruiser, gates). |
| `scripts/` | Fitness/report gate scripts (`arch:*`, `docs:ui`, `status:matrix`, coverage/parity reports). |
| [`audit/`](./audit/) | Point-in-time audit reports + generated status/coverage/parity matrices. |
