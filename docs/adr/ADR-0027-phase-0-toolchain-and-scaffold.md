# ADR-0027 — Phase 0 toolchain ratification + manifest-driven monorepo scaffold

- **Status:** Accepted
- **Date:** 2026-06-14
- **Phase:** 0 (pre-build scaffold + fitness harness hardening)
- **Resolves:** the architecture-readiness audit FAIL/PARTIAL items — "Source tree
  conformance FAIL", "Coding prerequisites FAIL", "Fitness scripts PARTIAL" (the
  `arch:boundaries` gate could not run: `depcruise` uninstalled, `apps/`+`packages/` absent).
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (manifest is the
  single source of truth; seam/outbox/foundation consumption is no-edge).
- **Operationalizes:** [`docs/PHASE_0_SCAFFOLD_PLAN.md`](../PHASE_0_SCAFFOLD_PLAN.md) (§2 locked
  decisions, §4 work packages).
- **Changes:** adds root tooling, the `apps/`+`packages/` skeleton, the M1 bootstrap, fitness
  fixtures, and CI. **No `module-manifest.ts` change** — the scaffold conforms to the manifest,
  never the reverse.

## Context

The repo was a spec corpus + a *design-time* fitness kit. The kit's scripts were "armed-but-inert"
(green with no source) and one gate (`arch:boundaries`) exited 127 because `dependency-cruiser`
was not installed and there were no `apps/`/`packages/` to cruise. There was no buildable tree, no
lockfile, and no committed toolchain — so "ready for implementation lock" was false. Phase 0's job
is to make `bun install && bun run arch:fitness` run **green end-to-end** and to prove a planted
violation makes each gate go **red**, without writing any business logic.

## Decision

### 1. Toolchain (ratifies PHASE_0_SCAFFOLD_PLAN.md §2)

| # | Decision |
|---|---|
| D-a | **Bun workspaces + committed `bun.lock`.** The repo previously git-ignored `bun.lock`; Phase 0 commits it (acceptance #1: clean-checkout `bun install` resolves). |
| D-b | **TypeScript project references (composite)** + `tsconfig.base.json`; a root solution `tsconfig.json` references every package/app so `tsc -b` builds the graph. |
| D-c | **TypeBox** for runtime validation. |
| D-d | **Fastify + BullMQ + Better Auth** installed as deps (no handlers in Phase 0). |
| D-e | **Vitest** as the test runner. |
| D-f | **All packages scaffolded empty** so the dependency-cruiser boundary graph is complete on day one. |

### 2. Bun linker = **hoisted** (new, beyond the plan)

Bun 1.3 defaults to the **isolated** linker, which scopes workspace deps to per-package
`node_modules` and leaves no top-level `node_modules/@wardenx/*` symlinks. TypeScript
(`moduleResolution: Bundler`) and dependency-cruiser both resolve cross-package imports from the
repo root, so we pin `[install] linker = "hoisted"` in `bunfig.toml`. Without this, `@wardenx/*`
imports fail to resolve and the boundary graph is blind to cross-package edges.

### 3. Manifest-driven scaffold + a new `arch:parity` gate

`scripts/scaffold-from-manifest.ts` generates the tree from `module-manifest.ts` `codePaths`
(idempotent; never overwrites hand-authored content) and, in `--check` mode, is the new
**`arch:parity`** gate (added to `arch:fitness`): it fails if a `codePath` has no directory, if the
root `tsconfig.json` references drift, or if an orphan `packages/*`/`apps/*` exists outside the
manifest. This keeps tree↔manifest parity enforced, not aspirational.

### 4. Real seam registry at the M1 bootstrap path

The example root `boot.ts` is promoted to `apps/backend/src/bootstrap/` (M1 `codePath`):
`seams/registry.ts` (`REQUIRED_SEAMS`, `registerSeam`/`getSeam`, `validateSeams()`),
`seams/providers.ts` (deny-stubs), `erasers/{registry,providers}.ts` (`validateErasers()`), and
`index.ts` (`bootSeams()`/`buildServer()`). Both validators **fail closed**. Seam interfaces live in
the leaf `@wardenx/types` (ADR-0005 D1/D3 — never `packages/foundation`). Placing the registry under
`seams/` **arms** the previously-inert seam sub-check of `check-fitness-gaps.ts`.

### 5. Fitness fixtures prove the gates enforce

`scripts/__fixtures__/<gate>/` holds the minimum code that trips exactly one gate; the Vitest
self-test (`scripts/__tests__/fitness-gates.test.ts`) asserts each gate **red** on its fixture and
**green** at the repo root. Fixtures live outside every gate's real scan set, so they never affect
the baseline.

## Deviations from the plan (recorded)

- **Package count is 31, not 33.** `@wardenx/mobile-offline` and `packages/iqies-client` are
  referenced in specs but are in **no manifest `codePath`** (mobile-offline is manifest-exempt —
  on-device sqlcipher, manifest header scope note). The plan's §2 sub-decision allowed scaffolding
  them as non-fitness-governed packages **or deferring**; we **defer** them (no code imports them
  yet) to keep the scan set 1:1 with the manifest. They are added when a `codePath` claims them.
- **`pnpm` references** in M37 §13 / T-29.01 are doc-level; flagged for a doc-hygiene sweep (D-a
  risk note), not blocking the scaffold.

## Consequences

- `bun install && bun run build && bun run arch:fitness && bun run test` is green on a clean
  checkout; CI runs all of it on every PR (`.github/workflows/ci.yml`).
- Phase 1 builds feature modules against working gates. The first feature PR should be a single thin
  vertical slice (M1+M2: real tables + RLS + one seam + one route) to validate the gates against real
  code before fanning out (PHASE_0_SCAFFOLD_PLAN.md §7).
- The fitness gates that were inert now arm automatically as source lands (schema → tenancy/ddl/phi;
  events-by-mN → event catalog; seams → seam registry).
