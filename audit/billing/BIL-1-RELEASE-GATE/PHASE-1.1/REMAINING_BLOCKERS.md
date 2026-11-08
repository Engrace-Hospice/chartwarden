# Remaining blockers

## P0 — core integrated certification absent

- **Response pipeline:** no real two-tenant capture → DB candidate adapter → resolver → approved ack dispatch test. Add and run on private PG with persisted final claim and application ledger assertions.
- **ERA pipeline:** no real synthetic X12 / Claim.MD adapter → encrypted capture → real ownership evidence → non-posting stage → authorized review test. Assert zero payments, adjustments, AR/balance changes and posting outbox rows.
- **Worker crash and fencing:** no actual multi-worker runtime/restart suite for response, resolver, dispatch, ERA discovery, ownership and delivery. Add deterministic test failure points and assert durable state after restart.
- **Recovery route:** actual auth plugin, permission resolver, ABAC scope, step-up and route must invoke the real PostgreSQL recovery store; test authorization denials and durable audit/no cursor/no posting.

These gaps prevent GO. Do not replace any with mocks.

## P1 — deployment rehearsal incomplete

Actual `deploy.sh` interruption around contract migration/startup was not run. Add disposable test doubles or a safe deployment rehearsal for pre-migration failure, post-commit/pre-start interruption, and operator-held contract failure. Preserve migrations 1353/1358 as contract.

## External / release blockers

- Claim.MD endpoint authorization, test credentials and vendor-certified synthetic fixtures remain unverified. No calls were made.
- CI, independent review, branch/PR reconstruction and merge permission remain Phase 1.2; merge is not authorized.
- Production activation, notices and automatic posting remain disabled.
