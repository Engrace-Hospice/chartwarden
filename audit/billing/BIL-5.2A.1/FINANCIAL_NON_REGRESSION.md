# Financial non-regression

The new routes call only M23/M41 read services. The integrated private HTTP test compares the tenant's `remittance_advice` count before and after the M23/M41 list, denied, foreign-cursor and detail reads; it remains unchanged. The routes do not invoke submission, Claim.MD ingestion, M25 posting, approval, outbox publishing or financial mutation services. Existing Claim.MD posting remains controlled by `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED`; this phase does not alter the production guard or accounting rules.

The private runner includes the directly relevant existing M25 835/outbox/consumer regressions. No live vendor calls are used.
