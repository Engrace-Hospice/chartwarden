# Verification record

## Executed

- Focused BIL-1.3/BIL-1.2 regression command: `bunx vitest run apps/backend/src/modules/23-billing-medicare/claimmd-ack apps/backend/src/modules/23-billing-medicare/claimmd-identity apps/backend/src/modules/23-billing-medicare/claimmd-evidence apps/backend/src/modules/23-billing-medicare/claimmd-capture apps/backend/src/modules/41-billing-commercial/domain/ack-transition.test.ts apps/backend/src/modules/41-billing-commercial/domain/ack-event.test.ts packages/billing/src/machines/claim-claimmd.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts` — **15 files, 103 tests passed**.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p packages/db/tsconfig.json --pretty false` — passed on the final source revision.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — passed on the final source revision.
- `bun run arch:tables` — passed: no cross-module schema access, raw-SQL or platform-bypass findings.
- `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-compat`, `bun run arch:migration-numbering`, `bun run arch:manifest-mirror`, `bun run arch:compliance` — passed on the final source revision.
- `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck:tests` — passed (unit and DOM test typecheck programs).
- `bun run build` — passed (all 14 TypeScript batches).
- `git diff --check` — pending after this report update.

## Still running / not run

The full monorepo suite and private PostgreSQL suites have not been run. No live Claim.MD request, production migration, deployment or worker activation was performed.

The private database test must use a disposable pgvector PostgreSQL cluster with `chartwarden_app` as a real NOBYPASSRLS role, a separate platform principal, synthetic tenant data, and no shared Docker cluster. Cover two tenants, two locations each, four provider entities, cross-tenant IDs, historical NPI/TIN, old/new attempts, same-account test/prod rows, duplicate/concurrent leases, crash after tenant commit, RLS denial and transactional M41 outbox. Confirm both modes leave the BIL-1.1 cursor unchanged.
