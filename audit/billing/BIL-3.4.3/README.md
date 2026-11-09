# BIL-3.4.3 — M25 transaction-scoped posting core

## Result

Extracted the shared M25 claim-posting persistence operation used by legacy `postAdvice` and an internal explicit-association path. The explicit path accepts a caller-owned transaction, checks the source digest and tenant/provider scope, confirms the selected claim through M25's payer-routed claim owner reader, and refuses financial facts outside one narrow fully paid claim case.

The existing `postAdvice` route remains the only production posting entry point. No Claim.MD posting endpoint, approval operation, worker, or activation flag was added. Claim.MD staging remains separate and nonposting.

## Verified boundary

The live database test proves M25 remittance-line persistence and transactional outbox events. Claim-state and CAP accrual consumers operate downstream from those events; this phase does not claim a synchronous AR ledger or bank reconciliation effect. See [M25_TRANSACTION_CORE.md](./M25_TRANSACTION_CORE.md) and [POSTGRESQL_FINANCIAL_TESTS.md](./POSTGRESQL_FINANCIAL_TESTS.md).
