# WardenX — Development Runbook

How to build, verify, and extend the WardenX monorepo. This is the Phase 0 output: a
buildable skeleton with CI-enforced architecture fitness. **No business logic yet** —
Phase 1 builds feature modules against the gates described here.

> Authority: architecture docs win over module/UI specs. The **manifest**
> (`architecture/module-manifest.ts`) is the single source of truth for what each module
> owns. See [ADR-0005](adr/ADR-0005-manifest-single-source-of-truth.md) and
> [ADR-0027](adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Prerequisites

- **Bun ≥ 1.3** (`.nvmrc` pins Node 22 for tooling that wants it). All scripts run via `bun`.
- Optional: `dot` (Graphviz) only for `bun run arch:graph` (artifact-only; never in the gate path).

## First run

```bash
bun install            # resolves from the committed bun.lock (hoisted linker, see bunfig.toml)
bun run build          # tsc -b across the project-reference graph
bun run arch:fitness   # scaffold parity + the fitness gates (incl. report freshness checks)
bun run test           # Vitest: boot smoke test + fitness-gate self-test (red/green)
```

All four are green on a clean checkout, and CI (`.github/workflows/ci.yml`) runs them on every PR.

## The commands

| Command | What it does |
|---|---|
| `bun run build` / `typecheck` | `tsc -b` the whole graph; `clean` removes build output. |
| `bun run scaffold` | (Re)generate the tree from the manifest (idempotent; never overwrites hand-authored files). |
| `bun run arch:parity` | `scaffold --check` — fails on tree↔manifest drift or orphan packages. |
| `bun run arch:boundaries` | dependency-cruiser: module import boundaries, leaves, vendor-adapter + helper-table rules. |
| `bun run arch:tables` | table ownership — no cross-module schema access. |
| `bun run arch:tenancy` | three-column rule, canonical `app.org_id`, no dangerous RLS shapes. |
| `bun run arch:ddl` | PostgreSQL DDL legality (partition keys, CHECK subqueries, duplicate enums). |
| `bun run arch:gaps` | event-catalog `mN.` naming, seam-registry completeness, PHI RLS/audit presence. |
| `bun run docs:ui` | UI screen-spec corpus consistency. |
| `bun run arch:ai-governance` | AI capability catalog ↔ per-capability docs parity (AI Governance §4.1/§4.4). |
| `bun run status:matrix` / `arch:status-matrix` | (re)generate / freshness-check the per-module implementation-status matrix (`audit/implementation-status/`); hard-fails on orphan (unowned) schema/migration tables. |
| `bun run ui:parity` / `arch:ui-parity` | (re)generate / freshness-check the UI implementation-parity report (`audit/ui-parity/`); hard-fails on duplicate screen id/path, unknown `requiredPermission`, or an unregistered `screens.ts`. |
| `bun run arch:fitness` | all of the above (parity + every fitness gate, including the report freshness checks). |
| `bun run test` | Vitest self-tests. |
| `bun run lint` / `lint:fix` | Biome (advisory; not in the blocking gate path). |

The fitness gates are **armed-but-inert**: they pass with no source and begin enforcing
automatically as a module's schema/seams/events land.

## How to add a module (Phase 1+)

1. **Confirm the manifest.** The module's `codePaths`, `dependsOn`, and `ownedTables` are
   already in `architecture/module-manifest.ts`. If a new table or dependency is needed, that is
   a deliberate architecture change — one consolidated ADR per module (ADR-0005 D5), then edit the
   manifest. Never reshape the manifest to fit code.
2. **Generate any missing dirs:** `bun run scaffold` (creates only what's missing).
3. **Schema** → `packages/db/src/schema/<module>.ts` as `export const x = pgTable("x", …)` for
   each `ownedTable`. Add `organization_id` (+ `provider_entity_id`/`location_id` on PHI tables),
   RLS keyed only on `app.org_id`, and an M4 audit trigger. `arch:tenancy`/`arch:ddl`/`arch:gaps`
   begin enforcing immediately.
4. **Cross-module reads** go through a **seam** (interface in `@wardenx/types`, registered in
   `apps/backend/src/bootstrap/seams/`, validated by `validateSeams()`) or an **outbox event**
   (`mN.<resource>.<verb>`) — **never** a direct schema import. Neither adds a `dependsOn` edge
   (ADR-0005 D1).
5. **Routes** under `apps/backend/src/modules/NN-slug/`, each behind
   `requirePermission`/`requireAbac`; emit audit events; register the module's eraser with M4.
6. **UI** per `docs/ui/screens/*` using the declared layout pattern (`docs:ui` stays green).
7. **Tests** (Vitest) including RLS cross-tenant isolation. Keep the fitness fixtures red.
8. **Regenerate the freshness-checked reports and commit them:** `bun run status:matrix && bun run ui:parity`.
   Adding schema/routes/screens makes `audit/implementation-status/` and `audit/ui-parity/` stale, so
   `arch:status-matrix` / `arch:ui-parity` (inside `arch:fitness`) go red until the committed reports are
   regenerated. (Their failure output also prints the exact command to run.)
9. Run `bun run build && bun run arch:fitness && bun run test` before opening the PR.

See the per-module Definition of Done in
[`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md).

## Layout

```
apps/        backend (Fastify host + src/bootstrap + src/modules/NN-slug), admin (M34), portal (M31)
packages/    leaves (shared, types, domain, ui); foundation (db, audit, auth, tenancy);
             + one package per spec'd domain area (see manifest codePaths)
architecture/ module-manifest.ts (source of truth) + .dependency-cruiser.cjs (generated rules)
scripts/     fitness gates + the scaffold generator; __fixtures__ (gate red-proofs); __tests__
```

## Proving the gates work

`scripts/__tests__/fitness-gates.test.ts` runs each gate against a one-violation fixture in
`scripts/__fixtures__/` and asserts it goes **red**, then asserts **green** at the repo root. If
you weaken a gate, a fixture test fails — that's the regression net.

## Enforcement model (free / private repo — no GitHub branch protection)

GitHub branch protection + rulesets require a paid plan on private repos, so `main` is protected by
three free layers instead:

1. **CI on every PR** — `.github/workflows/ci.yml` runs `build-and-verify` (install → `tsc -b` →
   `arch:fitness` → `vitest`) on each PR. The green/red status is visible before you merge.
2. **Local pre-push hook** — `.githooks/pre-push` blocks a **direct push to `main`** unless the full
   fitness suite passes. Activate once: `bun run setup:hooks` (auto-runs via the `prepare` script on
   `bun install`). Emergency bypass: `git push --no-verify` or `SKIP_FITNESS=1 git push`.
3. **PR discipline** — always merge via a PR after CI is green (see `plans/ARCHON_RUN_TRACKER.md`).

This isn't server-enforced (a paid plan would add that), but it catches the realistic failure modes:
broken code reaching `main` by direct push, and red PRs (CI flags them). If you later upgrade, enable a
ruleset requiring the `build-and-verify` check — the command is in the run tracker's notes.
