# Approval and Security

Two separate permissions were added: `remittance.posting.approve` and `remittance.posting.execute`. Both write routes require step-up; the service enforces provider scope again under tenant RLS. Plan creation uses the existing financial-review permission but does not grant approval. Approval writes only append-only authorization history and creates no M25 advice or financial outbox event.

The capability is controlled by `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED`, whose default is false. Startup rejects it when `NODE_ENV=production`; the execution service independently refuses while the gate is false. Automatic ERA posting remains prohibited. The private test is the only harness that passes `enabled: true` directly.

Plan rows are immutable; approval/execution rows are append-only, tenant scoped, and cross-checked against the stage/provider. Sensitive source data stays encrypted in the stage. The public API returns safe plan facts and result references only. The internal M25 posting port remains absent from route service objects and module barrels.
