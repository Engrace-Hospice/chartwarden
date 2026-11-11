# Non-regression

The original `postAdvice` path still uses automatic matching and delegates to the same transaction-scoped M25 claim posting operation. The explicit batch path is only available through the internal WeakMap-backed posting port used by the controlled Claim.MD review service; no public generic financial-write endpoint was added.

Claim.MD posting continues to use `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED`, default-disabled and guarded against production enablement. Existing manual/SFTP ingestion, M23/M24/M26 event contracts, single-claim result compatibility, RLS and approval/execute separation remain in the focused private runner.
