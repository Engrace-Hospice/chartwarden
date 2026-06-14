# Fitness-gate fixtures (Phase 0, PR-0.5)

Each subdirectory contains the **minimum** code that makes exactly one fitness gate fail,
proving the gate enforces (audit item #8 / PHASE_0_SCAFFOLD_PLAN.md north star).

These files live under `scripts/__fixtures__/`, which is **outside every gate's real scan
set** (the gates scan `packages/`, `apps/`, and `packages/db/src/schema` from the repo
root) — so they never affect the green baseline. The self-test in
`scripts/__tests__/fitness-gates.test.ts` runs each checker with its `cwd` pointed at the
fixture dir and asserts a non-zero exit, then runs it at the repo root and asserts green.
