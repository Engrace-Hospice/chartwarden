# Test and static-check results

No test suite was run beyond the focused offline tests below. No live database suite, service, migration, Claim.MD request, or production/sandbox transaction was run.

## Focused tests

Executed:

```sh
bunx vitest run packages/x12-837-client/src/clearinghouse/claimmd-account-response.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts
```

Result at the time recorded: **2 files passed, 6 tests passed**. Coverage includes nested event normalization, absent identity metadata, large decimal response identifiers, absence of provider identity in requests, shared request-budget behavior, successful durable capture contract, fetch failure behavior, and encryption/authentication checks. These are unit tests with fakes; they do not certify database transactions or vendor behavior.

## Requested follow-up commands

After completing missing database and runtime wiring, run the focused command above, then `bun run typecheck`, `bun run build`, `bun run arch:fitness`, and the new private-PostgreSQL live suite for response inbox RLS/cursor/concurrency. Add its named script and CI job per repository policy. Run the required non-live tests and `check:boot:platform` before a PR; do not run live tests against the shared Docker cluster.

## Live PostgreSQL suite added (not run)

`apps/backend/__tests__/m23-claimmd-response-inbox.live.test.ts` exercises FORCE RLS/tenant-app denial and competing lease acquisition against PostgreSQL. It uses the canonical `LIVE_DROP_ROLES` list and is registered as `test:m23:claimmd-response-inbox:live` in the lifecycle CI matrix. It was not run in this audit because no private disposable PostgreSQL instance was provisioned. The tenant app denial assertion checks the lack of grants; the capture concurrency assertion runs as the dedicated capture role. CI must prove it executes rather than self-skips.

## Build and architecture fitness

`bun run build` completed successfully across all 14 TypeScript batches.

`bun run arch:fitness` completed with 3 failures out of 48 gates:

- `arch:docling-lock`: environment blocker; `uv` is unavailable.
- `arch:status-matrix`: generated `audit/implementation-status/IMPLEMENTATION_STATUS.md` is stale.
- `arch:inject-coverage`: generated `audit/inject-coverage/INJECT_COVERAGE.md` is stale.

The migration-related gates passed: manifest mirror, table ownership, tenancy, DDL legality, migration numbering and compatibility. `arch:test-typecheck`, route reachability, live-suite coverage, and other checks also passed. Generated reports were not refreshed as part of this focused change. No claim of full architecture-fitness success is made.
