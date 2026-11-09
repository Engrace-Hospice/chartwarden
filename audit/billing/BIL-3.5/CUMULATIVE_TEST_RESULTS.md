# Cumulative test results

Executed on the current `develop` worktree:

- `scripts/test-m25-835-ingestion-private.sh`: M25 ingestion/controlled posting 40/40, M23/M24 consumer suite 7/7, M26 CAP consumer suite 4/4. Private PostgreSQL, synthetic data, app-role service path. This final full run includes the source-owner reader, date normalization, and duplicate legacy intake assertion.
- Focused private PG rerun `m25-835-ingestion.live.test.ts -t "executes a staged Claim.MD ERA through source validation"`: 1 passed, 39 skipped. Covers real M23/M41 historical reader composition, plan/approval/execution, and duplicate legacy intake blocked by matching stage identity.
- M25 capture/delivery/duplicate/recovery/resolution/review/legacy-stage-guard, route authorization, and historical candidate suites: 9 files, 43 tests passed.
- M25 ERA review DOM suite: 9 tests passed, including plan → approval → execute → history and default-off presentation.
- `bun run openapi:check`, `bun run client:check`: pass.
- `bun run arch:tables`, `bun run arch:tenancy`: pass.
- `bun run arch:migration-numbering`, `bun run arch:migration-compat`: pass.
- `bun run arch:ui-parity`: pass.
- `git diff --check`: pass.
- `bun run build`: pass, 14/14 TypeScript batches, exit 0.
- Targeted test TypeScript programs for the changed backend live/unit tests and M25 DOM test: pass.
- `bun run typecheck:tests`: the global Node test typecheck was attempted but interrupted under host memory pressure; no global result is claimed.

No live Claim.MD request or production migration was performed.
