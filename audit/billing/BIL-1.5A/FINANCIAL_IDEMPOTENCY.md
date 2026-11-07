# Cross-source financial idempotency

`service-drizzle.ts` now serializes posting by tenant/provider/payer/TRN and checks for another posted/partial-posted advice with the same amount and parsed content digest. An exact prior identity is persisted as `held_duplicate`; the financial mutation and posting outbox are skipped. Migration `1359_m25_financial_duplicate_hold.sql` adds the non-postable state (`compat: expand`). The guard deliberately does not infer duplication from amount/date alone.

This is conservative protection for supported exact identities, not universal exactly-once accounting. Cross-source collision and legitimate distinct-payment behavior need disposable PostgreSQL integration tests. Reversal/correction relationships and provider-level PLB distribution still require cumulative validation.
