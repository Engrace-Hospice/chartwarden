# Financial integrity gate

## Implemented safeguards and evidence

M25's common posting boundary serializes the supported exact identity by tenant/provider/payer/TRN with a PostgreSQL advisory transaction lock, then checks prior posted or partially posted records using trace, amount and immutable parsed-content digest. Missing identity is held; amount/date alone is not treated as proof. A duplicate discovered across import sources is retained in a non-postable held state. The lock and financial writes share the transaction.

The BIL-1.5B live M25 ingestion suite passed 35/35 on private PostgreSQL and covered concurrent and cross-source duplicate attempts. The M25 stage/review path remains explicitly non-posting: no `receiveAdvice`, `postAdvice`, or posting outbox path is called by stage delivery/review/recovery.

## Limits

This does not establish universal exactly-once accounting across every legacy/manual/SFTP path, nor comprehensive correction, reversal, secondary-payer and PLB semantics. Any identity outside the supported exact key remains held for authorized review. Release review must confirm every production-capable M25 ingress reaches the common posting boundary and every unsupported case remains non-postable.

Automatic financial posting activation: **NO**.
