# Test results

Executed:

- `bunx vitest run packages/x12-837-client/src/clearinghouse/notice-submission-evidence.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-evidence/cipher.test.ts` — 4 files, 18 tests passed.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b packages/x12-837-client packages/db apps/backend --pretty false` — passed. The default-heap invocation exited with V8 out-of-memory before reporting diagnostics; the repository-sized heap rerun passed.
- `bun run arch:tables` — passed (no cross-module access/ownership violation).
- `bun run arch:tenancy` — passed.
- `bun run arch:ddl` — passed.
- `bun run arch:migration-numbering` — passed; migration 1361 is uniquely numbered.
- `bun run arch:migration-compat` — passed; 1361 is declared `compat: expand`.
- `bun run arch:manifest-mirror` — passed; M23 owns both new tables in both manifest forms.
- `git diff --check` — passed.
- `bunx vitest run apps/backend/src/modules/23-billing-medicare/__tests__/transfer-notice-consumer.test.ts` — passed, 1 file / 5 tests.
- No live Claim.MD calls, PostgreSQL migration execution, or financial posting.

Coverage now includes the repository's synthetic NOE/NOTR/transfer X12 fixtures, distinct NOE/NOTR/transfer frequency discriminators (including transfer 8xD), exact notice control binding, unsupported transaction and incomplete identity rejection, no default-enabled notice transport, reserve-before-upload and receipt-after-upload ordering, separate TIN AAD, and preserving a queued NOE attempt ID across the outbox bridge. It does not provide real database RLS/trigger execution or vendor contract certification.

Deferred: cumulative BIL-1 suites, isolated PostgreSQL migration/RLS, multi-worker tests and synthetic Claim.MD test-account certification in BIL-1.5B after BIL-1.5A.3.
