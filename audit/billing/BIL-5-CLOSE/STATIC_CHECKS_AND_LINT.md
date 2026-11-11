# Static checks and lint

- Backend TypeScript: PASS.
- Admin TypeScript: PASS.
- Full `bun run build`: PASS.
- OpenAPI emit/client check: PASS.
- Route reachability, tenancy, provenance, merge-artifacts and live-suite coverage: PASS.
- `git diff --check`: PASS.
- Targeted changed-file Biome: PASS.

`bun run arch:fitness` was executed against the current worktree. 42 of 49 gates passed. The seven failures are:

- `arch:docling-lock`: `uv` is not installed in the environment.
- `arch:parity`: pre-existing manifest orphans `packages/domain` and `packages/admin-ui-shell`.
- `arch:status-matrix`: generated implementation-status report is stale.
- `arch:ui-parity`: generated UI parity report is stale.
- `arch:design-tokens`: pre-existing raw fallback color in `billing-operations.tsx`.
- `arch:openapi-coverage`: generated coverage report is stale.
- `arch:inject-coverage`: generated inject-coverage report is stale.

The passed gates include table ownership, tenancy/RLS shape, migration numbering and compatibility, route reachability, outbox bindings, live-suite coverage, OpenAPI provenance/check, and client consistency.

Repository-wide `bun run lint` remains **FAIL** only because the already-dirty `apps/backend/__tests__/m41-commercial-routes.live.test.ts` has formatter-only differences from the earlier BIL-5.2B.1 work. No BIL-5-CLOSE file is responsible for that failure.
