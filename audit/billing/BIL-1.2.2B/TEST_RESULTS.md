# Test results

Focused BIL-1.2.2B tests added:

- `claimmd-identity/candidate-provider.test.ts`: M23/M41 source row ownership, attempt key/control/payer/vendor/location checks, receipt namespace provenance.
- `claimmd-identity/resolve.test.ts`: exact vendor field semantics, cross-identifier conflict, file-only refusal, PCN-qualified receipt, bounded-search ambiguity.
- `claimmd-identity/config.test.ts`: absent/invalid flag stays disabled and protected inbox keyring parsing fails closed.
- `claimmd-transport.test.ts`: synthetic immediate `fileid` and reconciled `inboundid` provenance.

Existing focused service, resolver, evidence, and response capture tests remain part of the verification set. No broad monorepo suite, private DB suite, migration application, Claim.MD network request or deployment is allowed/performed in this record.

## Executed verification

The focused test command passed: **11 files, 80 tests**.
The TypeScript project build passed with an increased Node heap (`NODE_OPTIONS=--max-old-space-size=4096`).
`arch:ddl`, `arch:migration-compat`, `arch:migration-numbering`, `arch:manifest-mirror`, and `arch:tenancy` passed. `git diff --check` passed. `arch:tables` **failed** with four findings in `candidate-provider.ts`: direct references to M1 `location` and `provider_entity`, M41 `commercial_submission`, and the PHI/platform-context heuristic. This is a known blocking architecture defect; the candidate query must be refactored behind owner-exported readers before merge/activation.

Commands executed:

```sh
bunx vitest run \
  apps/backend/src/modules/23-billing-medicare/claimmd-identity \
  apps/backend/src/modules/23-billing-medicare/claimmd-evidence \
  apps/backend/src/modules/23-billing-medicare/claimmd-capture \
  packages/x12-837-client/src/clearinghouse/claimmd-transport.test.ts \
  packages/x12-837-client/src/clearinghouse/submission-evidence.test.ts \
  apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts \
  apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.test.ts
NODE_OPTIONS=--max-old-space-size=4096 bunx tsc -b ./apps/backend ./packages/x12-837-client ./packages/db
bun run arch:ddl
bun run arch:migration-compat
bun run arch:migration-numbering
bun run arch:manifest-mirror
bun run arch:tenancy
bun run arch:tables
git diff --check
```

The table-ownership result above is intentionally reported as a failure; it must pass after the cross-owner reads are moved behind owner-owned reader seams.

Initial affected TypeScript check exited 134 after Node hit its default ~2 GB heap limit; it emitted no TypeScript diagnostics. The increased-heap rerun passed. A private disposable PostgreSQL/NOBYPASSRLS live run remains required before resolver activation. No live DB suite, migration application, broad suite, API request, or deployment was run.
