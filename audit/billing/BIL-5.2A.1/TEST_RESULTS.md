# Test results

Fresh evidence for this increment:

- Private PostgreSQL M23 owner suite: 6/6 passed, including older-than-first-page records, same-timestamp attempt cursor traversal, tenant/provider filtering, using the restricted app role.
- Private PostgreSQL M41 authenticated route suite: 13/13 passed, including the 60-newer-claims case, source cursor continuation, tenant/provider denial, same-provider out-of-caseload exclusion, guessed detail 404, and M23/M41 routes registered in the same authenticated Fastify app.
- Billing Operations DOM files: 4 files, 22 tests passed; the dedicated operations component file reports 4/4.
- `openapi:emit`, `client:gen`, `openapi:check`, and `client:check` passed; both new operations have query and response contracts in the generated OpenAPI document (1972/1972 routes enriched).
- `arch:tables`, `arch:tenancy`, and `git diff --check` passed.
- Full private runner `scripts/test-m25-835-ingestion-private.sh`: passed in fresh private PostgreSQL, 50 M25 835 ingestion tests, 21 M25 golden/manual posting tests, 7 M23/M24 remittance-feedback consumer tests, 4 CAP consumer tests, 15 clearinghouse-pull tests, 13 M41 route tests, and 6 M23 reader/RLS tests.
- `bun run build` completed all 13 TypeScript project batches successfully. The full `bun run typecheck` then entered the repository-wide `tsconfig.tests.json` compilation but that test-typecheck process was interrupted before returning an exit status; it is not recorded as a pass.
- Full `bun run lint` passed (`Checked 8937 files`). `bun run arch:tables`, `bun run arch:tenancy`, OpenAPI/client checks, and `git diff --check` passed.

The Fastify suite uses the repository's synthetic `x-test-user` authentication adapter, actual registered route guards, source-owner services and the restricted `chartwarden_app` PostgreSQL role. It demonstrates application authorization and RLS; it does not certify the deployment IdP.
