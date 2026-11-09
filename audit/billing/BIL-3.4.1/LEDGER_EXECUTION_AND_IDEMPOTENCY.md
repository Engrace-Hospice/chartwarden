# Ledger execution and idempotency

No controlled posting entry point was added. M25 `postAdvice` runs financial writes within a transaction but is invoked by the existing `m25.edi.835_received` consumer. It does not consume a BIL-3.3-approved posting plan. Do not route Claim.MD staging through `receiveAdvice` as a shortcut.

Future execution must bind plan validation, approval, duplicate-effect checks and existing M25 domain writes to one transaction and preserve manual/SFTP behavior.
