# BIL-1.5B executed validation

Live tests used private disposable `pgvector/pgvector:pg18` on loopback port 55433, one fresh database per suite. Neither the local `.env` database nor shared `os-postgres-1` was used. Suites replayed the repository migration baseline. No vendor request or production migration was made.

| Command/group | Result | Scope and notes |
|---|---|---|
| Initial focused Claim.MD suite | PASS: 56 files, 645 passed, 7 skipped | Before independent-review corrections; not the final cumulative count. |
| Final M23/M25/M41 + X12 non-live group | PASS: 161 files, 1,992 passed, 12 skipped | Full relevant module/package test run. |
| Recovery route, ERA recovery, ERA delivery, operational metrics | PASS: 4 files, 15 passed | Platform role, recovery job registration and terminal delivery changes. |
| ERA delivery focused regression | PASS: 5/5 | Includes stage-finalization recovery after another worker commits a terminal receipt. |
| M25 835 ingestion live | PASS: 35/35 | Initial 30/35 exposed five fixtures lacking synthetic TRN; corrected fixtures, unchanged posting guard. Includes actual concurrent/cross-source posting cases. |
| M25 RLS live | PASS: 16/16 | Real app role on private PostgreSQL. |
| M23 response inbox live | PASS: 3/3 | Initial 1/3 exposed lease-pair and ciphertext-length fixture defects; fixtures corrected, schema unchanged. |
| M23 RLS live | PASS: 13/13 | Real app role, tenant isolation and claim chain. |
| M23 clearinghouse submission live | PASS: 16/16 | Submission retries and in-doubt behavior. |
| M41 commercial claim live | PASS: 34/34 | Claim domain and tenant scope. |
| M41 commercial submission live | PASS: 88 passed, 4 skipped | Private PostgreSQL submission suite. |
| M23 NOE draft live | PASS: 17/17 on rerun | Initial run exposed an outbox fixture timing issue; bounded tick loop and exact-one assertion added. |
| M6 readmission/NOTR live | PASS: 10/10 | Queued submission identity on readmission path. |
| M23 transfer notice live | PASS: 7/7 | Transfer submission and tenant scope. A repeat after the temporary PostgreSQL container had stopped was blocked before test execution (connection refused; 7 skipped); the original isolated run passed. |
| `NODE_OPTIONS=--max-old-space-size=8192 bun run build` | PASS: 14 batches | Re-run after the final source/test typing correction. |
| `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck:tests` | PASS: exit 0 | Final rerun on the completed source/test tree, including the last test typing correction. |
| Architecture checks | PASS | tables, tenancy, DDL, migration compatibility/numbering, manifest mirror, compliance, route reachability, ABAC predicates/composition and `git diff --check`. Migration-numbering gaps are historical/informational. |

First typecheck attempt found six fixture type errors (missing notice `submissionId`; nullable optional TRN); all were corrected. The outbox fixture was then adjusted after the first NOE live run produced 16/17. Final NOE live run passed 17/17.

**Not run / blocked:** Claim.MD test-account requests; populated pre-BIL-1 in-place migration and interrupted-deploy rehearsal; full authenticated recovery invocation against live PostgreSQL; complete two-tenant/four-provider integrated response and ERA worker run; cross-version rolling-deployment proof; remote CI and formal PR approval. These are not passes.
