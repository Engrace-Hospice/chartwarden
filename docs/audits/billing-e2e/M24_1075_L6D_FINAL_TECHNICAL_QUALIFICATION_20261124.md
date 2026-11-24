# M24-1075-L6D — Final technical qualification

Date: 2026-11-24
Branch: `audit/m24-1075-oregon-eocco-readiness-r2`
Starting HEAD: `2245b885cfd9818974e8a6487e3cc7056a3b3d3b`
PR: [#1115](https://github.com/Engrace-Hospice/chartwarden/pull/1115), remains Draft

## Disposition

`M24_1075_L6D_COMPLETE`

The L6D implementation and directly affected security/integrity boundaries passed the targeted qualification described below. This is source-level runtime-topology evidence using an existing local image with the current source mounted read-only. It is not immutable release-image, full production Compose, payer, or production qualification. The PR remains Draft pending the integrated qualification checkpoint.

## What changed

- Persisted trusted assessments now carry a paired evidence fingerprint and observation timestamp. Reassessment requires a new version, and historical records are not backfilled or promoted. API projections call this a point-in-time, nonposting observation and do not expose the fingerprint as current eligibility.
- Assessment-content fingerprints are separate from actor-bound operation/idempotency identity. Legacy matching fingerprints no longer establish evaluator trust. Reassessment checks immutable source identity and preserves the trust classification of old history events.
- Multi-claim artifacts are held unless organization, provider, vendor, account, environment, canonical payer and Medicaid program attribution are consistent across every claim.
- The M24-owned submission seam fingerprints the authoritative assignment, classification, provider, claim, submission and acknowledgment facts. It verifies submitted service state, route channel, MCO snapshot and control number against the claim before it exposes qualified submission evidence. Unverified results redact claim, payer, program, attempt and acknowledgment identifiers; no synthetic document or local DRAFT/READY state becomes submission evidence.
- The actual Fastify API is mounted through its session, permission and provider-scope path and sends signed bounded commands to a separate evaluator runtime. The evaluator independently resolves current authority and uses the restricted source reader and writer.
- Concurrent evaluations use asynchronous HTTP requests. The live test observes overlapping evaluator SQL statements and an actual artifact-lock wait. Review/history/idempotency writes remain transactional; stale versions and conflicting key reuse are refused.
- List, detail and history API reads are verified against persisted audit rows. Notes, dispositions and reopen remain nonfinancial review actions.

No posting operation, M24 financial claim transition, financial outbox event, vendor transport, payer request, or ERA retrieval was added.

## Runtime and database boundary

The focused live test used a fresh database in the private disposable PostgreSQL container `m24-l6d-pg-20261124`, with the ordered migration chain applied through 1548 and the runtime roles provisioned. Tenant checks used the non-bypass application role. The isolated evaluator and Fastify API ran as separate disposable containers; the evaluator had no published port and used an internal Docker network. API-to-evaluator requests traversed that network over HTTP. The test used synthetic-only secrets, an existing local `wardenx-api:latest` image, and read-only mounts of the current backend source, packages and dependencies. The evaluator ran at the configured 768 MiB/1 CPU limit.

This proves source-level runtime topology, request authentication/authorization, role separation, and evaluator communication. It does not prove the bytes or startup behavior of a newly built immutable image, the complete production Compose overlay, or release deployment topology. No production or shared database was used. Temporary evaluator/API containers and networks were removed by the test harness; the private PostgreSQL container was removed after the remaining checks.

## Targeted qualification

| Check | Result |
|---|---|
| Focused M24/M25/M40 unit suites (`m24-seam-submission-evidence`, M25 review service and evaluator, M40 classification overlap, mounted route unit suite) | **84 passed / 84** across 5 files. |
| M24 submission-evidence PostgreSQL cases | **5 passed / 40 filtered out** in `f172-m24-remittance-feedback.live.test.ts`; exercised verified-attempt qualification and service-state, route-channel, MCO-snapshot, and control-number mismatch refusal. |
| Mounted Fastify + evaluator + restricted writer PostgreSQL case | **1 passed / 29 filtered out** in `m25-rls-isolation.live.test.ts`. It exercised the six mounted review operations; source/digest and evidence checks; assessment persistence/history; duplicate and stale operations; real overlapping HTTP requests and lock wait; evaluator restart/unavailable behavior; tenant/provider authorization; direct-write refusal; and no-posting assertions. List, detail and history audit rows were asserted in the final run. |
| Changed-file Biome | Passed; 19 source/test files checked after the final code/test changes. |
| Scoped PHI scan | Passed; all modified/untracked files in scope were clean. |
| `git diff --check` | Passed. |
| Focused architecture/security gates | Table ownership, DDL legality, tenancy/FORCE RLS, migration compatibility/numbering, manifest mirror, compliance, route reachability, outbox bindings, live-suite coverage, architecture/documentation checks, and Compose policy passed. Existing architecture-doc warning stamps remain warning-only. |
| OpenAPI and generated client checks | `bun run openapi:check` and `bun run client:check` passed; public route schemas did not change in the final seam-redaction correction. |
| Targeted TypeScript | The bounded strict source-graph check reported no remaining L6D source diagnostic after correction, but exited on the existing unrelated `packages/x12-837-client/src/testing/local-fake-http-client.ts:82` `Uint8Array<ArrayBufferLike>` versus `BodyInit` error. It is reported as a failure, not a pass. |

Exact live commands:

```sh
CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:synthetic-l6d-disposable@127.0.0.1:55439/chartwarden_test CHARTWARDEN_TEST_NO_PGVECTOR=1 bunx vitest run apps/backend/__tests__/f172-m24-remittance-feedback.live.test.ts -t 'fully verified production attempt|attempt service state|attempt channel|attempt MCO|attempt control number'
```

```sh
CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:synthetic-l6d-disposable@127.0.0.1:55439/chartwarden_test M25_TEST_EVALUATOR_CONTAINER=1 M25_TEST_API_CONTAINER=1 M25_TEST_POSTGRES_CONTAINER=m24-l6d-pg-20261124 M25_EVALUATOR_TEST_IMAGE=wardenx-api:latest bunx vitest run apps/backend/__tests__/m25-rls-isolation.live.test.ts -t 'persists a synthetic Claim.MD 835 through the isolated evaluator runtime and restricted writer'
```

The focused unit command was:

```sh
bunx vitest run apps/backend/__tests__/m24-seam-submission-evidence.test.ts apps/backend/__tests__/m25-medicaid-era-review-service.test.ts apps/backend/__tests__/m25-medicaid-era-trusted-review.test.ts apps/backend/__tests__/m40-medicaid-classification-overlap.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/medicaid-era-review.routes.test.ts
```

## Review findings

The focused independent integrity review confirmed the M24 evidence digest and submission/acknowledgment consistency checks and found no critical or high issue. The compliance review found no critical or high PHI/security issue. Its medium observation that the list read audit was not asserted in the live test was corrected; the final mounted live run now asserts the list, detail, and history audit records. The runtime report and CW-AC-01 evidence explicitly classify this as source-mounted topology rather than release-image qualification.

## Verification debt register — PR #1115

These checks are deferred to the integrated qualification checkpoint after the dependent implementation lots, before PR review/merge. Deferred checks are not passes.

| Deferred check | Reason/status | Relevant scope | Last known evidence / checkpoint |
|---|---|---|---|
| Full monorepo tests and unrelated PostgreSQL live suites | Deliberately deferred by the L6D execution amendment; targeted M24/M25/M40 tests ran here. | All modules; particularly billing/remittance regression. | Previous L6C2 report records that the full unit suite was not rerun. Run the integrated suite before merge. |
| Full repository typecheck and backend project build | Deliberately deferred. The prior L6C2 backend build OOMed at a 2 GiB heap; this L6D scoped graph still encounters the unrelated X12 `BodyInit` diagnostic described above. | Backend plus package dependency graph. | No full build claimed for L6D. Re-run through the approved integrated CI/build checkpoint and resolve/classify the X12 diagnostic there. |
| Full repository lint, `arch:fitness`, and dependency-cruiser | Deliberately deferred by amendment; relevant focused architecture and changed-file lint gates passed. | Monorepo. | Full campaigns were not run for L6D. Run once at integrated qualification. |
| Immutable application image and full release Compose topology | Not built or claimed. Source-mounted API/evaluator containers exercised actual internal HTTP and security boundaries. | API/evaluator packaging, Compose deployment. | Build and qualify the release image/topology at integrated deployment qualification. |
| Full-repository PHI scan and Gitleaks | Scoped PHI scan passed. Local Gitleaks is unavailable. | Full repository/secrets. | Run approved CI secret scan at integrated qualification; do not treat unavailable Gitleaks as a pass. |
| Exhaustive review of unchanged historical commits and unrelated M23/M41 suites | Deliberately deferred; current diff and affected M24/M25/M40 seams received focused review/regression. | Full PR history and unaffected integrations. | Perform consolidated PR review and contract-selected regressions at integrated qualification. |

## Remaining limitations and safety

F09 remains open. There is no qualified production Medicaid ERA source account, EOCCO enrollment, real M24 submission provenance, payer-certified format/route, operator UI, or authorized financial posting path. Stedi JSON is still not parsed as raw X12. `isolated_evaluator` means the assessment was produced through the restricted evaluator path; a persisted observation is not current eligibility or payment authority. Any later financial use requires fresh authoritative evidence and a separately qualified transactional authorization path.

Medicaid electronic submission remains disabled. No vendor/payer request or live ERA retrieval occurred. No real patient PHI was used. No payment was posted, no M24 financial claim state or financial outbox event was changed, no unverified evidence was promoted, and no production/shared migration or deployment occurred.
