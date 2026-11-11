# Transport and financial nonmutation

Both endpoints execute SELECT-only readers. The tenant UI refresh only repeats GET requests. No call reaches capture, delivery, replay, recovery, matching mutation, approval, posting, ledger, or outbox publication.

`CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` defaults remain unchanged. No worker or vendor connection was activated.
