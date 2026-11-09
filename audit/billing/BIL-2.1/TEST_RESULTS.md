# Test results

## Executed

- `bunx vitest run apps/backend/__tests__/billing-medicare-inject.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.test.ts` — **PASS, 4 files / 82 tests**. This includes real route registration/authorization checks using the approved in-memory HTTP harness, not PostgreSQL.
- `bunx vitest run apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts` — **PASS, 1 file / 33 tests**.
- `git diff --check` — **PASS** on the final source/documentation diff.
- `bun run arch:tables && bun run arch:tenancy && bun run arch:ddl && bun run arch:route-reachability` — **PASS** (table ownership, tenancy, DDL legality, and 273 route registrars reachable).
- `bun run arch:migration-numbering` — **PASS** (662 migrations; only historical gaps reported; no migration was added).
- `bun run arch:migration-compat` — **PASS** (all 52 post-1288 migrations declare valid compatibility; no migration was added).
- `bun run openapi:emit && bun run client:gen && bun run openapi:check && bun run client:check` — **PASS**; the new preparation route has a generated client contract.
- `bun run arch:openapi-provenance` — **PASS** (no duplicate aliases; all declared route keys unique).
- `bun run arch:openapi-coverage` — **FAIL on pre-existing unrelated coverage debt**: M25 has two unenriched routes and bootstrap has one unenriched route plus one mutating route without a body schema. This BIL-2.1 route is enriched and did not add to those counts; the coverage report was regenerated.
- Backend TypeScript (`NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false`) — **PASS** after building the backend's referenced `types`, `shared`, `tenancy`, `audit`, and `db` project outputs. The first check against stale package `dist` output failed with unrelated M16/M22 missing-export/schema diagnostics; the targeted dependency build resolved those diagnostics, and the rerun passed.
- Web TypeScript (`NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/web/tsconfig.json --noEmit --pretty false`) — **FAIL on existing M16 bereavement generated-client/type errors**. The final run emitted no errors in the changed `claim-editor.tsx`; the M16 contract errors include missing generated operation types and resulting implicit-any errors. The first run also reported M23 generic-depth errors; the response was simplified and the UI uses a local explicit response type at the typed endpoint boundary, after which no M23 diagnostic remained.

No live Claim.MD calls, production migration, full monorepo suite or global build are part of this phase.

The 115 passing tests across five files cover exact scoped route match, multiple provider/MAC routes, organization/provider/account/environment mismatch, expiry, invalid dates, ambiguity, blank payer ID, global override rejection, route-fingerprint revalidation before upload, existing notice guard behavior, submit outbox propagation, M23 claim rendering/validation loader non-regression, authorized/denied preparation reads, and submit-route blocking when the route is not configured.

The preparation route is covered in the existing `billing-medicare-inject.test.ts` route-registration suite rather than a separate test file: authorized read, missing-permission denial, and the pre-submit fail-closed route guard are exercised. Authorization composition reuses the existing claim read guard. The composition now also requires M40's active X12 payer reader before returning `verified`, but a real-database test of that read and its permissions remains part of cumulative validation. These in-memory route tests do not certify PostgreSQL/RLS, live route configuration or Claim.MD vendor behavior.
