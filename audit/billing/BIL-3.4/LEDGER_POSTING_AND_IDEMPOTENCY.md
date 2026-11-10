# Ledger posting and idempotency

The existing M25 `postAdvice` is the financial mutation service; its outbox consumer can create remittance records, allocations, adjustments, and downstream events. The Claim.MD stage/review flow does not call it. No controlled Claim.MD posting path is implemented in this phase, so no new posting idempotency key or duplicate-effect ledger was added. Existing manual/SFTP behavior was not changed.

The missing gate is an atomic domain entry point that validates the approved plan and BIL-3.3 source decisions within the same transaction as existing ledger writes, protected by existing financial-effect identity constraints.
