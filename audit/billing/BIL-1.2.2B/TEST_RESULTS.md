# Test results

Focused BIL-1.2.2B tests added:

- `claimmd-identity/candidate-provider.test.ts`: M23/M41 source row ownership, attempt key/control/payer/vendor/location checks, receipt namespace provenance.
- `claimmd-identity/resolve.test.ts`: exact vendor field semantics, cross-identifier conflict, file-only refusal, PCN-qualified receipt, bounded-search ambiguity.
- `claimmd-identity/config.test.ts`: absent/invalid flag stays disabled and protected inbox keyring parsing fails closed.
- `claimmd-transport.test.ts`: synthetic immediate `fileid` and reconciled `inboundid` provenance.
- `bootstrap/__tests__/foundation-site-reader.test.ts` and `41-billing-commercial/services/claimmd-submission-reader.test.ts`: owner-reader field projection, bounded/empty lookup, and caller transaction use.
- `packages/tenancy/__tests__/context.test.ts`: repeatable-read isolation is set before the platform audit and owner reads share the transaction.

Existing focused service, resolver, evidence, and response capture tests remain part of the verification set. No broad monorepo suite, private DB suite, migration application, Claim.MD network request or deployment is allowed/performed in this record.

## Executed verification

Historical initial verification: **11 files, 80 tests passed**; the TypeScript project build, DDL, migration compatibility, numbering, manifest, tenancy, and whitespace checks passed. The initial `arch:tables` run failed with four findings in `candidate-provider.ts` (direct M1/M41 table references and the platform-context PHI heuristic).

After hardening: **14 files, 108 tests passed**. The final `arch:tables` rerun passed with no violations. The affected TypeScript project build passed with `NODE_OPTIONS=--max-old-space-size=4096` after the Medicare-only unit case was added. Migration compatibility, numbering, manifest, tenancy, DDL and whitespace gates passed. Two attempts at the broader `typecheck:tests` command were interrupted before they yielded a result, so that separate test-program check is **not certified** by this report.

Commands executed:

```sh
bunx vitest run \
  apps/backend/src/modules/23-billing-medicare/claimmd-identity \
  apps/backend/src/modules/23-billing-medicare/claimmd-evidence \
  apps/backend/src/modules/23-billing-medicare/claimmd-capture \
  apps/backend/src/bootstrap/__tests__/foundation-site-reader.test.ts \
  apps/backend/src/modules/41-billing-commercial/services/claimmd-submission-reader.test.ts \
  packages/tenancy/__tests__/context.test.ts \
  packages/x12-837-client/src/clearinghouse/claimmd-transport.test.ts \
  packages/x12-837-client/src/clearinghouse/submission-evidence.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts \
  apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.test.ts
NODE_OPTIONS=--max-old-space-size=4096 bunx tsc -b ./apps/backend ./packages/x12-837-client ./packages/db ./packages/tenancy
bun run arch:ddl
bun run arch:migration-compat
bun run arch:migration-numbering
bun run arch:manifest-mirror
bun run arch:tenancy
bun run arch:tables
git diff --check
```

The initial table-ownership failure is retained above as history; the hardening run passed after cross-owner reads moved behind owner-owned readers. `bun run typecheck:tests` should be executed in CI or a sufficiently provisioned local session before merge.

Initial affected TypeScript check exited 134 after Node hit its default ~2 GB heap limit; it emitted no TypeScript diagnostics. The increased-heap rerun passed. A private disposable PostgreSQL/NOBYPASSRLS live run remains required before resolver activation. No live DB suite, migration application, broad suite, API request, or deployment was run.
