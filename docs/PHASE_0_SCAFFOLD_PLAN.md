# WardenX — Phase 0 Scaffold Plan (proposal)

**Status:** ✅ EXECUTED 2026-06-14 (PR-0.1 … PR-0.7). Toolchain (§2) ratified in
[ADR-0027](./adr/ADR-0027-phase-0-toolchain-and-scaffold.md); runbook in [DEVELOPMENT.md](./DEVELOPMENT.md).
`bun install && bun run build && bun run arch:fitness && bun run test` is green; each gate has a
red-proof fixture. (Original plan status: "Toolchain decisions LOCKED 2026-06-14; PR sequencing
pending go-ahead. No code written.")
**Author:** generated 2026-06-14 in response to the architecture-readiness audit.
**Goal:** turn the spec corpus + fitness kit into a *buildable* monorepo skeleton, so a coding
agent (Archon or otherwise) can implement feature modules against working CI gates —
**without** writing any business logic.

> **North star:** the success test is not "files exist" but **"`bun install && bun run
> arch:fitness` runs green end-to-end, and a deliberately-planted boundary/ownership/RLS/DDL
> violation makes it go red."** Today neither is possible — `depcruise` isn't installed (no
> lockfile) and `apps/`+`packages/` don't exist, so `arch:boundaries` exits 127.

---

## 1. Scope & guardrails

### In scope (structure only)
- Monorepo workspace + lockfile so `bun install` resolves.
- TypeScript project graph (base config + per-package configs).
- The `apps/` + `packages/` directory tree, **derived from the manifest** (3 apps, 29
  codePath packages, + 4 leaf/foundation packages = 33 packages), each with a minimal
  `package.json`, `tsconfig.json`, and `src/index.ts` placeholder.
- `drizzle.config.ts` + an empty migrations dir + the `packages/db` schema barrel.
- `.env.example`, `.github/workflows/ci.yml`, root tooling config.
- The **real** seam registry at `apps/backend/src/bootstrap/` (promoting the example `boot.ts`),
  with `validateSeams()` wired but no real providers.
- **Fitness-gate fixtures**: tiny intentional-violation samples (behind a test flag/dir) that
  prove each gate fails for the right reason, plus the green baseline.

### Explicitly NOT in scope
- No feature/business logic, no real Drizzle tables, no routes, no React screens.
- No `dependsOn`/`ownedTables` changes — the manifest is the contract; the scaffold conforms
  to it, never the reverse.
- No DB provisioning/secrets — `.env.example` only.

### Architecture guardrails (must hold at every step)
- The 40-module boundary model is law. dependency-cruiser rules are **generated from the
  manifest** — scaffold packages must map 1:1 to `codePaths` so the boundary graph is real.
- ADR-0005 stays in force: seam/outbox/foundation consumption is no-edge; scaffold imports
  must not introduce edges the manifest doesn't sanction.
- Leaf packages (`shared`, `types`, `domain`, `ui`) depend on nothing app-specific.
  Foundation helpers (`audit`, `auth`, `tenancy`, `db`) importable without a `dependsOn` edge.

---

## 2. Locked decisions (ratified 2026-06-14)

All six are decided; the scaffold builds against these.

| # | Decision | **LOCKED** | Notes |
|---|---|---|---|
| D-a | Package manager / workspaces | **Bun workspaces + `bun.lock`** | All scripts already use `bun run`. **Action:** scrub the stray `pnpm fitness:manifest` references in M37 §13 / T-29.01 during PR-0.1. |
| D-b | TS module graph | **TypeScript project references** (composite) + `tsconfig.base.json` | Per-package incremental builds + a second compile-time boundary check (tsc fails on illegal cross-package imports), reinforcing dependency-cruiser. |
| D-c | Validation library | **TypeBox** | Specs (M14/M37/…) already author schemas as TypeBox discriminated unions. |
| D-d | Web framework / queue / auth | **Fastify + BullMQ + Better Auth** | All named in specs (Fastify logger, BullMQ queue catalogs, ADR-0026 Better Auth). Installed as deps in Phase 0; no real handlers. |
| D-e | Test runner | **Vitest** | Chosen over `bun test` for richer mocking/snapshot support that Phase 1 feature tests will want. Runs via `vitest run` in CI. |
| D-f | Scaffold breadth | **All 33 packages, empty** | Makes the dependency-cruiser boundary graph complete on day one so fitness gates are fully exercised. Cheap (empty stubs). |

Sub-decision (under D-f): `@chartwarden/mobile-offline` and `packages/iqies-client` (spec-referenced,
not in any codePath) are scaffolded as **non-fitness-governed** packages — present in the workspace
for builds, excluded from the dependency-cruiser/table-ownership scan set (mobile-offline is
manifest-exempt per the header scope note).

---

## 3. Target tree (derived from `module-manifest.ts` codePaths)

```
apps/
  backend/            # Fastify host; owns src/bootstrap (M1 seam registry, RLS ctx, outbox)
    src/
      bootstrap/      # ← promote boot.ts here: registry.ts, seams, eraser-registry, validateSeams()
      modules/        # 40 dirs NN-slug/ (e.g. 05-patient, 30-quality, 37-ipu) — empty shells
  admin/              # M34 SaaS admin console (placeholder app)
  portal/             # M31 patient/family portal (placeholder app)
packages/             # 29 from codePaths + leaves(domain, ui) + foundation already listed
  shared/  types/  domain/  ui/            # LEAVES
  audit/  auth/  tenancy/  db/             # FOUNDATION HELPERS (db holds the Drizzle schema barrel)
  assessments/ hope/ hearthnote/ narrative-vocab/ dosespot/ routing-client/
  forms/ intake-extraction/ billing/ medicaid-adapters/ cost-report/ fhir/
  telehealth-client/ ai-platform/ saas/ messaging/ terminology/ mdm/ consent/
  quality/ cahps-vendors/ subscription-billing/ inpatient/
```

> Note: `@chartwarden/mobile-offline` and `packages/iqies-client` are referenced in specs but are
> **not** in any manifest codePath. mobile-offline is intentionally manifest-exempt (on-device
> sqlcipher; see the manifest header scope note). Decide per-package whether to scaffold them as
> non-fitness-governed packages or defer. (Tracked as a sub-decision under D-f.)

The exact list is generated, not hand-typed — a `scripts/scaffold-from-manifest.ts` reads
`MODULES` and emits the dirs + stub `package.json`/`tsconfig.json`, guaranteeing tree↔manifest parity.

---

## 4. Work packages (sequenced PRs)

Each PR is independently green-able; CI runs `arch:fitness` on every one.

**PR-0.1 — Workspace + toolchain.**
Root `package.json` workspaces globs, `bun.lock`, `tsconfig.base.json`, formatter/linter config,
`.env.example`, `.nvmrc`/engines. Install `dependency-cruiser` (+ `dot` note) so `arch:boundaries`
*runs* (it'll pass trivially with no source). **Exit:** `bun install` resolves; `bun run
arch:fitness` executes all six gates green.

**PR-0.2 — Generated package/app skeletons.**
`scripts/scaffold-from-manifest.ts` + the 33 `packages/*` and 3 `apps/*` shells (stub
`package.json`, `tsconfig.json` with project-ref `references`, `src/index.ts`). Each module dir
under `apps/backend/src/modules/NN-slug/` created empty. **Exit:** `tsc -b` builds the empty
graph; `arch:boundaries` now traverses real (empty) packages.

**PR-0.3 — Foundation contracts (types only).**
`packages/types` gets the seam interfaces + outbox event-name/payload types (leaf-typed, per
ADR-0005). `packages/db` gets the Drizzle schema *barrel* (empty re-export) + `drizzle.config.ts`
+ empty `migrations/`. No tables yet. **Exit:** `arch:ddl` and `check-fitness-gaps` run against a
real (empty) schema surface instead of being inert.

**PR-0.4 — Real seam registry at the M1 bootstrap path.**
Move `boot.ts` → `apps/backend/src/bootstrap/{registry,seams,eraser-registry,interfaces}.ts`.
`validateSeams()` + `validateErasers()` wired into a `buildServer()` that aborts on missing
required seam. Providers are `NotImplementedError` deny-stubs (this is the *correct* home for the
T-29.01 deny-stub concept — code stubs, not manifest edges). **Exit:** a boot smoke-test asserts
`validateSeams()` throws when a required seam is unregistered and passes when all stubs are present.

**PR-0.5 — Fitness-gate fixtures (prove gates fail right).**
Under `scripts/__fixtures__/` (or a `--self-test` mode), add minimal samples that each violate
exactly one rule — cross-module schema import, unowned-table write, missing RLS/withOrgContext,
illegal DDL, an `mN.` event-catalog breach — and a test that asserts each gate **red** on its
fixture and **green** on the baseline. This is the audit's item #8 and the real proof the kit works.

**PR-0.6 — CI workflow.**
`.github/workflows/ci.yml`: `bun install` → `tsc -b` → `bun run arch:fitness` → `vitest run` →
`bun run docs:ui`. Matrix on push/PR. Optional: render `arch:graph` SVG as an artifact.

**PR-0.7 — Docs + ADR.**
ADR ratifying the toolchain decisions (§2), and a `CONTRIBUTING`/`docs/DEVELOPMENT.md` "how to
add a module" runbook that points at the generator and the fitness gates.

---

## 5. Acceptance criteria (Phase 0 "done")

1. `bun install` resolves from a committed lockfile on a clean checkout.
2. `tsc -b` builds the whole project-reference graph (empty but type-correct).
3. `bun run arch:fitness` runs **all six** gates to completion and is **green**.
4. Each fitness gate has a fixture that makes it **red**, asserted by Vitest (`vitest run`).
5. `apps/`+`packages/` map 1:1 to manifest `codePaths` (generator-enforced parity).
6. `validateSeams()`/`validateErasers()` execute at boot and fail closed on a missing entry.
7. CI runs all of the above on every PR.
8. **Zero** business logic, real tables, or routes introduced; manifest unchanged.

---

## 6. Risks & mitigations

- **Bun vs pnpm drift in specs** → resolve D-a first; scrub stray `pnpm` references in the same PR.
- **Scaffold drifting from the manifest over time** → the generator + a `check-scaffold-parity`
  gate (new, optional) keeps tree↔manifest in lock-step; add to `arch:fitness`.
- **`depcruise` needing the `dot` binary** for `arch:graph` → keep graph rendering out of the
  required CI path (artifact-only), so a missing Graphviz never reds the build.
- **Premature framework lock-in** → scaffold installs Fastify/BullMQ/Better-Auth as deps but
  writes no handlers, so swapping later is cheap.

---

## 7. What this plan deliberately leaves to Phase 1+

First feature PR after Phase 0 should be a **single thin vertical slice** (e.g., M1 foundation +
M2 identity: real tables + RLS + one seam + one route) to validate the gates against *real* code
before fanning out to all 40 modules.
