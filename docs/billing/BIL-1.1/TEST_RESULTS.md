# Test and static-check results

No test suite was run beyond the focused offline tests below. No live database suite, service, migration, Claim.MD request, or production/sandbox transaction was run.

## Focused tests

Executed:

```sh
bunx vitest run packages/x12-837-client/src/clearinghouse/claimmd-account-response.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts
```

Current focused command:

```sh
bunx vitest run packages/x12-837-client/src/clearinghouse/claimmd-account-response.test.ts packages/x12-837-client/src/clearinghouse/claimmd-transport.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-identity/service.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-ack/service.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-ack/interpret.test.ts
```

Result: **6 files passed, 66 tests passed, 0 failed, 0 skipped**. Coverage includes nested event normalization, absent identity metadata, large decimal response identifiers, absence of provider identity in requests, shared request-budget behavior, JSON/XML envelope normalization, DTD/malformed XML refusal, capture failure/cursor behavior, encrypted payload/AAD checks, and identity/ACK/transport regressions. Tests use fixtures and fake fetch; they do not certify database transactions or vendor behavior.

TypeScript commands executed for this change:

```sh
bunx tsc -b packages/x12-837-client --pretty false
NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/backend --pretty false
```

Both commands exited 0. This is a project typecheck, not a PostgreSQL/RLS qualification.

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


## CM-5A.3A tenant inbox foundation (2026-11-15)

Focused regression command (synthetic fixtures and mocked transports only) covered the tenant account resolver, tenant DEK cipher, archive-before-ACK handoff, read-only legacy cursor inventory, platform-capture tenant refusal, and existing Claim.MD identity/ACK/transport paths:

```sh
bunx vitest run apps/backend/src/modules/23-billing-medicare/claimmd-tenant-inbox/*.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/config.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts packages/x12-837-client/src/clearinghouse/claimmd-account-response.test.ts packages/x12-837-client/src/clearinghouse/claimmd-transport.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-identity/service.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-ack/service.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-ack/interpret.test.ts
```

Result: **12 files passed, 98 tests passed, 0 failed, 0 skipped**. The suite does not execute Drizzle persistence against PostgreSQL and does not prove database uniqueness, RLS or concurrency.

TypeScript/static commands executed:

```sh
NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/backend --pretty false
bunx tsc -b packages/db --pretty false
bun run arch:migration-numbering
bun run arch:migration-compat
bun run arch:tenancy
bun run arch:manifest-mirror
```

All exited 0. Targeted Biome and `git diff --check` also passed for the changed non-live files. The existing live M23 RLS suite was extended with tenant inbox row-isolation/immutability coverage, but it was **not executed**; the repository compliance guard blocked an attempted formatting command that named the destructive live suite, and no `/hooks` authorization was requested or granted in this lot. Migration 1493 has not been applied to PostgreSQL. No vendor calls were made.
