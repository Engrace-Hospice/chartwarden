# Financial Posting Safety and Concurrency

## Current guard

`apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts` serializes M25 `postAdvice` by tenant, provider, payer and TRN with `pg_advisory_xact_lock(hashtextextended(..., 0))`. Under that lock it checks other `posted`/`partial_posted` advice rows for the exact scoped TRN, total payment amount and parsed-content digest. A match moves the current advice to `held_duplicate` with safe reason `CROSS_SOURCE_POSTED_IDENTITY` before line, adjustment, ledger, denial or outbox effects. The lock and financial writes share the transaction. `queueEnvelope` uses the same lock key for legacy receive and Claim.MD staging coordination.

This avoids treating amount/date alone as identity and scopes the identity by organization/provider/payer. Different providers or payers do not collide. Different content digests remain distinct; no rule here proves correction/reversal linkage.

## Correction in this phase

An advice without TRN or without persisted content digest previously skipped the duplicate guard and could proceed to financial effects. It is now placed in `held_duplicate` with `MISSING_FINANCIAL_IDENTITY`. It remains visible for review and is not posted.

## Test coverage added

The live M25 PostgreSQL suite now includes concurrent repeated posting of one advice and concurrent posting of two independent advice records sharing the exact identity, as well as a missing-TRN hold. Tests assert persisted status and remittance-line counts. The independent second row is inserted as a fixture to model a legacy/manual intake record that bypassed today's receive-time duplicate check; posting still goes through the actual M25 service.

These are runnable tests but were not executed: `CHARTWARDEN_TEST_DATABASE_URL` was absent. Mock/unit results do not establish PostgreSQL lock atomicity.

## Limits

- No universal exactly-once claim is made for all legacy/manual/SFTP integrations until every path is proven to invoke `postAdvice` or the common guard.
- The legacy schema has no explicit correction/reversal relationship. A changed digest is treated as distinct rather than silently merged; payer/provider-specific correction semantics need DB-backed fixtures and an authorized review workflow.
- Atomicity between financial effects and outbox publication depends on the injected publisher using the supplied transaction; the live concurrent tests do not yet exercise a production catalog-validating publisher.
- Claim.MD staged ERA cannot call financial posting from the new review or delivery code.
