# ERA requeue and recovery

**Not implemented in BIL-1.5A.** Existing capture retries and delivery receipts remain as previously implemented in `claimmd-era-store.ts` and `claimmd-era-delivery.ts`. There is no operator-facing, idempotent audited requeue operation with reason, actor, prior state, and immutable recovery history. Do not manually update central ERA states as a substitute. This is a release blocker and requires a dedicated central recovery action record, privileged platform authorization, fenced state transitions, and concurrent recovery tests.
