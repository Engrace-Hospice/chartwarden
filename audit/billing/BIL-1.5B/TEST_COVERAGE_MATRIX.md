# Billing Lot 1 cumulative coverage matrix

Prepared before BIL-1.5B test execution. `PENDING` in the final column means that the full phase-specific certification remains incomplete; executed subsets and exact results are recorded in [TEST_RESULTS.md](TEST_RESULTS.md). Historical results remain in each phase's `TEST_RESULTS.md`. All fixtures are synthetic. Database suites use a private disposable PostgreSQL cluster, never the local `.env` target or `os-postgres-1`.

| Phase | Source contracts / tables / migration | Focused tests and gaps | Runtime flag / external dependency | Financial effect | BIL-1.5B state |
|---|---|---|---|---|---|
| 1.1 response capture | M23 `claimmd-capture`, response stream/batch/event; 1350 | `capture.test.ts`, `config.test.ts`, `m23-claimmd-response-inbox.live.test.ts`; multi-worker fencing and page failure DB proof required | `CLAIMMD_RESPONSE_CAPTURE_ENABLED`; Claim.MD test account only for vendor certification | None | PENDING |
| 1.2 identity resolution | M23 `claimmd-identity`, response resolution/history; 1351 | `resolve`, `service`, `event-identifiers`, candidate tests; historical collision and RLS DB proof required | `CLAIMMD_IDENTITY_RESOLUTION_ENABLED`; no external call for fixture test | None | PENDING |
| 1.2.2A submission evidence | M23 `claimmd-evidence`, `clearinghouse-submission`; evidence/receipt observation; 1352 | evidence cipher, submission, shared `submission-evidence.test.ts`; pre-send commit and immutable DB proof required | Existing M23/M41 submit paths; external upload must remain disabled | Claim submission only | PENDING |
| 1.2.2B candidate runtime | M23 candidate adapter with M1/M41 owner readers; 1353 `contract` | candidate-provider and resolver tests; live platform-role, repeated PCN and multiple attempts required | resolver flag; no vendor request | None | PENDING |
| 1.3 acknowledgment | M23 `claimmd-ack`, M41 ack application, application/delivery ledger; 1354–1355 | config/delivery/interpret/service, M41 ack machine tests; transactional replay and stale version DB proof required | `CLAIMMD_ACK_DISPATCH_ENABLED` / shadow; no vendor request for fixtures | Claim status only, never M25 posting | PENDING |
| 1.4 ERA capture | M25 `claimmd-era-capture`, account ERA client, central ERA stream/inbox; 1356 | account ERA transport, capture and routing; pagination, crash and cursor DB proof required | `CLAIMMD_ERA_CAPTURE_ENABLED`; vendor test account only for certification | None | PENDING |
| 1.4.1A ownership | M25 ERA resolution, M23/M41 evidence readers, 835 parser; 1357 | ERA resolution/routing, 835 parser suites; mixed payee, multiple transaction sets and RLS DB proof required | `CLAIMMD_ERA_OWNERSHIP_RESOLUTION_ENABLED`; fixture mode no external call | None | PENDING |
| 1.4.1B staging | M25 ERA delivery/history and tenant stage; 1358 `contract` | delivery/duplicate/legacy guard/review tests; crash and concurrent delivery DB proof required | `CLAIMMD_ERA_M25_DELIVERY_ENABLED`; no vendor request | Protected stage only; auto-post prohibited | PENDING |
| 1.5A review and capture composition | M25 review route, M23 runtime wiring; 1359 financial hold | review route tests, response inbox live suite, M25 posting live suite; real route/RLS proof required | Independent flags, protected keyring | Review read only; existing posting guard applies to old sources | PENDING |
| 1.5A.1 recovery / financial safety | M25 recovery store/service/audit; 1360 | recovery tests and `m25-835-ingestion.live.test.ts`; DB locks/outbox final state required | internal operator only | No recovery posting; common M25 posting guard | PENDING |
| 1.5A.2 notice evidence | M23 notice store/send paths, shared notice evidence; 1361 | notice evidence, NOE/NOTR/transfer tests; vendor support remains unverified | `M23_CLAIMMD_NOTICE_UPLOAD_ENABLED` must remain false | No financial posting | PENDING |
| 1.5A.3 ops/metrics/readiness | platform ERA recovery route, M23/M25 operational readers | route and metrics tests; live operator/RLS/metrics and worker preflight tests required | No new activation flag; account/environment/keyring binding | No recovery posting | PENDING |

## Execution groups

1. Cumulative non-live tests: Claim.MD transport, M23 capture/identity/evidence/ack/notices, M41 submission/ack, M25 capture/resolution/delivery/review/recovery, 835 parser and financial unit suites.
2. Private PostgreSQL suites, sequential on a fresh database per suite: response inbox, M25 835 ingestion, M25 RLS, M23 clearinghouse submit, M41 commercial claims, plus new focused integration tests where required by discovered gaps.
3. Full relevant TypeScript build/test typecheck and architecture/compliance gates on the final combined tree.
4. Approved vendor test account and independent review are separate gates; unavailable credentials/permissions are BLOCKED, never PASS.
