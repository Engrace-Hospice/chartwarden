# M24-1075-L6B-FIX — Trusted writer and live PostgreSQL qualification

Date: 2026-11-23  
Repository: `Engrace-Hospice/chartwarden`  
Branch: `audit/m24-1075-oregon-eocco-readiness`  
Starting HEAD: `e324b764cb67f1884bc8d2cf057016bdc33a22a0`

## Disposition

`M24_1075_L6B_BLOCKED`

The synthetic repository-wired PostgreSQL flow now succeeds through the actual M25 Claim.MD artifact reader, L5 evaluator, M24/M40 reader seams, audited workflow writer, durable review and review history. The central Claim.MD delivery-state read was moved behind the existing audited Claim.MD store after the live run showed that the tenant application role correctly lacked access to that table.

The privileged-writer blocker is not closed. In a disposable database, `chartwarden_platform_login` directly inserted an assessment that passed the staged-artifact identity trigger while asserting `decision_status='payment_reported'` and `safe_summary.postingAuthorized=true`. It also directly changed an assessment and its summary without adding review history. Both SQL probes were rolled back. No approved isolated writer credential or evaluator attestation mechanism was available to enforce a stronger boundary. The workflow's `withPlatformContext` audit is an application-level control and does not prevent SQL issued with that privileged credential.

No migration was added. No production/shared database was used.

## A. Baseline and Git state

- Starting branch and HEAD matched the supplied baseline; the tree was clean before this work.
- Branch: `audit/m24-1075-oregon-eocco-readiness`.
- Existing PR #1088 remains Draft; issue #1075 remains open.
- Working changes for this fix are limited to the Claim.MD store/reader, the M25 live RLS integration test, and qualification documentation. No rebase or history rewrite was performed.

## B. Privileged-role security model

The disposable PostgreSQL role inspection returned:

| Role | BYPASSRLS | Member of platform role | Review INSERT | Review UPDATE |
|---|---:|---:|---:|---:|
| `chartwarden_app` | no | no | no | no |
| `chartwarden_platform` | no | yes | yes | yes |
| `chartwarden_platform_login` | yes | yes | yes | yes |

The review table owner in the test database was `postgres`. The login is not a superuser, but it bypasses RLS, inherits the platform carrier's review DML grants, and can issue direct SQL without going through the application writer. The table trigger checks source identity and version increments; it does not verify that the evaluator produced the values or require a matching history row.

Threat disposition:

- Ordinary tenant SQL and unauthorized API actors: existing grants, RLS, actor checks and API permissions deny direct assessment writes.
- Compromised tenant application credentials: cannot write the review tables directly, though application compromise remains subject to the app's authorized platform-job paths.
- Direct use or compromise of the shared platform SQL credential / platform worker: **can forge or tamper with assessments**; unresolved and blocking.
- Database owner or superuser: outside the controls available here; such an actor can alter schema, triggers and grants. No claim of protection is made.

The platform bypass audit records that the application used an approved platform context. It is not an independent evaluator signature and cannot prove the SQL statement came from the evaluator.

## C. Actual source of evaluator integrity

The successful flow proves that application composition reaches the evaluator and durable writer when synthetic source/account evidence is coherent. It does not make the persisted assessment evaluator-attested against direct privileged SQL. Digest checks bind the reader to staged source bytes; the database trigger binds row identity to the stage; neither binds decision fields or financial summary to the L5 algorithm.

The direct INSERT and UPDATE probes establish that a correct staged digest is insufficient. `postingAuthorized` is JSON summary data and is not constrained false by a database check. A replacement boundary needs a separately controlled writer capability or a verifiable attestation whose signing key is unavailable to the database SQL role. No such approved infrastructure was identified, so no cosmetic hash, session marker, or shared database secret was added.

## D. Database changes and migrations

- No migration was introduced or edited.
- Existing migrations 1542/1543 were applied only by the repository's live suites to a disposable PostgreSQL database.
- No legacy review was promoted or backfilled.
- Direct SQL forgery/tamper probes were wrapped in transactions and rolled back.

## E. Successful synthetic PostgreSQL flow

The added positive test in `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` creates isolated synthetic organization/provider/payer/classification/enrollment records; encrypts a synthetic Claim.MD 835 fixture using the existing protected-payload cipher; persists its inbox, verified ownership resolution, tenant stage, and matching central `delivered` receipt; registers the real MDM and M24 published seams; creates the real Claim.MD store, `buildDrizzleMedicaidEraReviewReaders`, L5 evaluator and `buildDrizzleMedicaidEraReviewWorkflow`; then evaluates and reads the persisted review through the NOBYPASSRLS application client. This specifically proves the central duplicate reader classifies a normal delivered handoff as nonduplicate and permits review evaluation to continue.

Observed and asserted:

- The stored source digest matches the bytes returned by the protected artifact reader.
- Organization, provider, vendor, account, test environment, payer and M40 classification identity persist coherently.
- The test source has no qualified real M24 production submission; it remains a nonposting review-required assessment rather than a matched production payment.
- `postingAuthorized` is false in the actual evaluator-produced safe summary.
- Initial review version and `assessed` history are persisted.
- Re-evaluating identical evidence is idempotent and adds no duplicate history.
- An authorized note and investigation disposition create versioned history.
- A stale transition is rejected.
- Platform bypass audit events are present for the real reader and writer operations.

The fixture's verified source enrollment and source records are synthetic, disposable test data only. They establish code-path behavior, not Claim.MD, EOCCO or payer qualification.

## F. Privileged forgery and tampering results

Direct PostgreSQL probes were run against the same disposable database after the M25 fixture initialized its roles and schema:

1. As `chartwarden_platform_login`, a direct INSERT using a staged source identity succeeded. The fabricated row asserted `payment_reported`, an arbitrary payer program, and `postingAuthorized: true`. The INSERT was rolled back.
2. In a separate transaction, direct UPDATE of an existing review changed decision, fingerprint, summary, and version to `postingAuthorized: true`. The update succeeded while history count remained unchanged. The UPDATE was rolled back.

These are confirmed blocking findings, not accepted security behavior. The platform credential can forge the assessment fields even though it cannot falsify the stored source bytes. No approved human risk acceptance was provided, and Codex does not grant one.

## G. Idempotency, concurrency and history

The real writer integration test covers identical-evaluation replay, initial history, note and disposition history, and stale-version rejection. It does not qualify simultaneous evaluator transactions, conflicting idempotency-key reuse, or concurrent note/disposition races in this fix. More importantly, the privileged SQL probe demonstrates that history immutability alone does not prevent an UPDATE by the platform credential to assessment fields; the direct assessment table has broader platform DML than its append-only history table.

## H. API-level qualification

This fix did not invoke the Fastify routes end to end. Existing L6B route tests and API/OpenAPI checks remain the prior evidence; they do not replace a live API test backed by this successful reader/writer fixture. No API behavior is claimed as newly qualified here.

## I. M23/M24/M25/M41 compatibility

The production reader no longer selects `claimmd_era_delivery` using the tenant application connection. It first resolves a tenant-visible stage, then asks the existing Claim.MD store to read the matching central delivery state using `CLAIMMD_ERA_RESOLUTION_JOB_ID` and its audited platform context. Account, organization, provider, usage and stage ID all scope that lookup. `delivered` is a normal nonduplicate handoff; exact/possible duplicate states remain holds/classifications; unexpected states or multiple rows fail closed as conflict. The live positive fixture contains a matching central `delivered` row. This avoids granting the tenant role central-table access and preserves test/production account separation.

No M23, M24 claim-state, M25 posting, or M41 contract was changed. Full M23/M41 regressions were not rerun as no shared payment or posting interface changed.

## J. Verification commands and results

All PostgreSQL work used disposable container `codex-m24-1075-l6b-fix-pg` on `127.0.0.1:55439`, with `max_locks_per_transaction=1024` and fresh suite resets. The container is removed after verification.

- `CHARTWARDEN_TEST_DATABASE_URL=… bunx vitest run packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts -t 'persists a real synthetic'` — 1 passed; actual reader/evaluator/writer/history path.
- `CHARTWARDEN_TEST_DATABASE_URL=… bunx vitest run packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` — 30/30 passed after correcting duplicate-reader delegation, preserving test/production duplicate scope, and mapping normal delivered receipts to nonduplicate.
- `CHARTWARDEN_TEST_DATABASE_URL=… bunx vitest run packages/db/migrations/__tests__/m24-rls-isolation.live.test.ts` — 70/70 passed.
- Disposable role-grant query — confirmed `chartwarden_platform_login` has `BYPASSRLS` and review INSERT/UPDATE.
- Direct privileged SQL INSERT probe — succeeded, then rolled back.
- Direct privileged SQL UPDATE/tampering probe — succeeded with no history insertion, then rolled back.
- `bunx biome check --write` on the modified TypeScript files — passed.
- Full prior repository tooling limitations remain as documented in the L6B report: backend TypeScript OOM, architecture-boundary memory exhaustion, unavailable local `uv` and Gitleaks, and pre-existing architecture parity orphans. This fix did not rerun or relabel those gates as passing.
- `git diff --check` is run before publication.

## K. Independent security conclusion

The independent review found and led to a fix for one reader regression: normal central `delivered` receipts were initially mapped to a conflict; the code now maps them to nonduplicate, and the actual live fixture includes a matching central delivered row. The final security conclusion remains **blocking**: application-level audited writer composition and source-identity triggers do not constrain a direct SQL session authenticated as `chartwarden_platform_login`. Direct assessment INSERT and tampering were reproduced. A dedicated credential with independent lifecycle/process isolation or a vetted external attestation design must be implemented and reviewed before L6B can be called complete. A database owner/superuser remains outside this boundary.

## L. Remaining qualification gates

- Enforce an evaluator-only write boundary that the general platform SQL credential and workers cannot assume, or introduce an independently verifiable attestation with key material outside database/platform SQL access.
- Add a regression test proving direct privileged INSERT/UPDATE is rejected or that forged records are cryptographically excluded from every authorized read path.
- Exercise mounted Fastify API operations against the real persisted service, including authorization failures and stale/idempotent mutation behavior.
- Revisit full repository TypeScript and architecture gates using the documented bounded CI runner; prior OOM/unavailable results remain incomplete, not passes.
- External source-account enrollment, real M24 submission provenance, Claim.MD Medicaid qualification and EOCCO payer qualification remain separate future requirements.

## M. GitHub and safety

Changes are prepared on the existing branch for a focused commit and PR #1088 update. PR #1088 must remain Draft; issue #1075 remains open. No merge, deployment or production migration is authorized.

Medicaid electronic submission remained disabled. No live vendor/payer request or ERA retrieval occurred. No payment, M24 financial claim transition or financial outbox event occurred. No synthetic evidence was promoted to production qualification. No EOCCO rate/enrollment/authorization or secondary Medicaid Room & Board path was enabled.

## L6C follow-up — 2026-11-23

L6C added migration 1544 to remove `chartwarden_platform` / `chartwarden_platform_login` write access to Medicaid ERA review and history, marked existing rows `legacy_unverified`, redacted their assessment summaries from tenant APIs, and removed the shared `DATABASE_PLATFORM_URL` writer binding from M25. The repository still has no isolated evaluator runtime or separately controlled writer secret. Therefore the previously successful L6B positive write path is no longer available after migration 1544, and L6C remains `M24_1075_L6C_BLOCKED` pending a genuinely isolated evaluator-to-writer implementation. See [L6C security qualification](./M24_1075_L6C_SECURITY_QUALIFICATION_20261123.md). The original L6B direct-SQL exploit evidence above is retained as historical evidence; it is not being represented as fixed by the L6B implementation itself.
