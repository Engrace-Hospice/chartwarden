# Remaining blockers

1. **Critical:** no posting-plan-bound M25 operation consumes the approved BIL-3.3 match/review decisions. Implement transaction-level source/approval/duplicate checks before reusing ledger domain operations.
2. **High:** no durable plan and separate posting approval/version history.
3. **High:** no controlled ledger execution, idempotency across import channels, rollback test, or posting result API/UI.
4. **High:** no M25 service-line match consumer for evidence captured under migration 1396.
5. **High:** no live accounting tests for supported payment, adjustments, duplicate ingestion, or concurrency.
6. **External:** no payer-specific confirmation of outbound line reference behavior. Do not generate 6R without route evidence.
